const prisma = require("../config/db");
const wallet = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const { notify, notifyAllAdmins } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");
const corporate = require("../services/corporate.service");
const { logAdminAction } = require("../services/auditLog.service");

// Booking flow (escrow first, like Handa's shopper requests):
//
//   1. The customer posts a request with a budget; the budget is taken from
//      their wallet straight away and held as booking.escrowKobo.
//   2. Every online, verified artisan in that category gets the request
//      (or only the chosen artisan for a direct booking). Each can accept
//      the customer's price, send their own price, offer "Price on Hold"
//      (assess at the customer's place first), or decline.
//   3. The customer accepts, counters or rejects each offer. The first
//      accepted price wins: the request closes for everyone else and the
//      escrow is topped up from, or partly refunded to, the customer's
//      wallet so it equals the agreed price.
//   4. Either side can cancel until a price is agreed (escrow refunded).
//      With Price on Hold the price is agreed on site: the artisan submits
//      it after arriving and the customer accepts it (topping up if short).
//   5. Artisan starts and finishes the job; finishing moves the escrow into
//      payout holds, released when the customer confirms (or automatically
//      after the escrow window). No cash anywhere.

const MIN_PRICE_KOBO = 50000; // ₦500
const OPEN = ["REQUESTED"];
const ACTIVE = ["REQUESTED", "ACCEPTED", "PAID", "IN_PROGRESS", "COMPLETED"];

const ARTISAN_PUBLIC = {
  id: true,
  userId: true,
  category: true,
  bizName: true,
  yearsExp: true,
  ratingAvg: true,
  ratingCount: true,
  jobsDone: true,
  user: { select: { id: true, name: true, avatarUrl: true } },
};

// What the customer sees: their booking, the matched artisan (with phone,
// for calls), and the live offers.
const CUSTOMER_VIEW = {
  customer: { select: { id: true, name: true, avatarUrl: true, phone: true } },
  artisan: { select: { ...ARTISAN_PUBLIC, user: { select: { id: true, name: true, avatarUrl: true, phone: true } } } },
  offers: { where: { status: { in: ["PENDING", "ACCEPTED"] } }, include: { artisan: { select: ARTISAN_PUBLIC } }, orderBy: { updatedAt: "desc" } },
};

// What an artisan sees before they get the job: no customer phone number.
const REQUEST_VIEW = {
  customer: { select: { id: true, name: true, avatarUrl: true } },
  artisan: { select: ARTISAN_PUBLIC },
};

// The matched artisan's view of their job, including the customer's phone.
const JOB_VIEW = {
  customer: { select: { id: true, name: true, avatarUrl: true, phone: true } },
  artisan: { select: { ...ARTISAN_PUBLIC, user: { select: { id: true, name: true, avatarUrl: true, phone: true } } } },
};

function io(req) {
  return req.app.get("io");
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function naira(kobo) {
  return "₦" + Math.round((kobo || 0) / 100).toLocaleString("en-NG");
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "The artisan";
}

function customerView(id, tx = prisma) {
  return tx.booking.findUnique({ where: { id }, include: CUSTOMER_VIEW });
}

async function requestViewFor(bookingId, artisanId) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: REQUEST_VIEW });
  if (!booking) return null;
  const myOffer = await prisma.bookingOffer.findUnique({ where: { bookingId_artisanId: { bookingId, artisanId } } });
  return { ...booking, myOffer };
}

// "Others" is for jobs that fit no listed trade: every artisan can see and
// answer them. Any other request only reaches artisans in its own category.
const OTHERS = "Others";
const categoryMatches = (bookingCategory, artisanCategory) => bookingCategory === OTHERS || bookingCategory === artisanCategory;
const categoryFilter = (bookingCategory) => (bookingCategory === OTHERS ? {} : { category: bookingCategory });

// Online, verified artisans in the request's category who haven't declined
// it — or just the chosen artisan for a direct booking.
async function requestRecipients(booking) {
  const where = {
    isAvailable: true,
    isVerified: true,
    kycStatus: "APPROVED",
    ...categoryFilter(booking.category),
    user: { status: "ACTIVE" },
    userId: { not: booking.customerId },
    offers: { none: { bookingId: booking.id, status: { in: ["DECLINED", "REJECTED", "CLOSED"] } } },
  };
  if (booking.artisanId) where.id = booking.artisanId;
  return prisma.artisanProfile.findMany({ where, select: { id: true, userId: true } });
}

// Live updates. The customer's own channel always gets the full booking;
// artisans get request-shaped events so their pop-up can add, update or
// remove the request.
function pushToCustomer(sock, booking) {
  sock?.to(`user:${booking.customerId}`).emit("booking:updated", booking);
}

async function pushRequestToArtisan(sock, bookingId, artisan) {
  const view = await requestViewFor(bookingId, artisan.id);
  if (view) sock?.to(`user:${artisan.userId}`).emit("request:updated", view);
}

async function closeRequestForArtisans(sock, booking, exceptArtisanId) {
  const artisans = await prisma.artisanProfile.findMany({ where: categoryFilter(booking.category), select: { id: true, userId: true } });
  for (const a of artisans) {
    if (a.id !== exceptArtisanId) sock?.to(`user:${a.userId}`).emit("request:closed", { bookingId: booking.id });
  }
}

function pushJobToArtisan(sock, booking) {
  if (booking.artisan) sock?.to(`user:${booking.artisan.userId}`).emit("job:updated", booking);
}

// Make the escrow equal the agreed price: take the shortfall from the
// customer's wallet, or return what's left over to it.
async function settleEscrow(tx, booking, priceKobo) {
  const diff = priceKobo - booking.escrowKobo;
  if (booking.corporatePlanId) {
    if (diff > 0) await corporate.debitPlan(tx, booking.corporatePlanId, diff);
    else if (diff < 0) await corporate.creditPlan(tx, booking.corporatePlanId, -diff);
    return priceKobo;
  }
  if (diff > 0) {
    await wallet.debitWallet(booking.customerId, diff, "ESCROW_HOLD", {
      bookingId: booking.id,
      reference: generateReference("ESC"),
      description: `Escrow top-up for ${booking.category} job`,
    }, tx);
  } else if (diff < 0) {
    await wallet.creditWallet(booking.customerId, -diff, "ESCROW_REFUND", {
      bookingId: booking.id,
      reference: generateReference("REF"),
      description: `Unused escrow returned for ${booking.category} job`,
    }, tx);
  }
  return priceKobo;
}

// ---------------------------------------------------------------- create

async function createBooking(req, res, next) {
  try {
    const { issue, address, lat, lng, priceKobo, scheduledAt, artisanId } = req.body;
    let { category } = req.body;
    const budget = Number(priceKobo);

    let direct = null;
    if (artisanId) {
      direct = await prisma.artisanProfile.findFirst({
        where: { id: artisanId, isVerified: true, kycStatus: "APPROVED", user: { status: "ACTIVE" } },
        select: { id: true, userId: true, category: true, isAvailable: true, user: { select: { name: true } } },
      });
      if (!direct) return res.status(404).json({ error: "That artisan isn't available for booking." });
      if (direct.userId === req.user.id) return res.status(400).json({ error: "You can't book yourself." });
      if (!direct.isAvailable) return res.status(409).json({ error: `${firstName(direct.user.name)} is offline right now. Try again later or book another artisan.` });
      category = direct.category;
    }

    if (!category || !issue || !address || !budget) {
      return res.status(400).json({ error: "Service, description, address and budget are required." });
    }
    if (budget < MIN_PRICE_KOBO) return res.status(400).json({ error: `The minimum budget is ${naira(MIN_PRICE_KOBO)}.` });

    let plan = null;
    if (req.body.corporate) {
      plan = await corporate.activePlanFor(req.user.id);
      if (!plan) return res.status(409).json({ error: "You don't have an active corporate plan." });
      if (!corporate.coversCategory(plan, category)) return res.status(400).json({ error: `${category} isn't one of your plan's services.` });
      if (corporate.callsLeft(plan) === 0) return res.status(409).json({ error: "You've used all the service calls on your plan for this period." });
    }

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          customerId: req.user.id,
          category,
          issue,
          address,
          lat: lat !== undefined ? Number(lat) : null,
          lng: lng !== undefined ? Number(lng) : null,
          priceKobo: budget,
          escrowKobo: budget,
          paidAt: new Date(),
          scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
          artisanId: direct ? direct.id : null,
          corporatePlanId: plan ? plan.id : null,
        },
      });
      if (plan) {
        await corporate.debitPlan(tx, plan.id, budget);
        await tx.corporatePlan.update({ where: { id: plan.id }, data: { callsUsed: { increment: 1 } } });
      } else {
        await wallet.debitWallet(req.user.id, budget, "ESCROW_HOLD", {
          bookingId: created.id,
          reference: generateReference("ESC"),
          description: `Escrow for ${category} request`,
        }, tx);
      }
      return created;
    });

    const recipients = await requestRecipients(booking);
    for (const a of recipients) {
      await pushRequestToArtisan(io(req), booking.id, a);
      notify(io(req), a.userId, "BOOKING", "New job request", `${category}: ${issue} — customer offers ${naira(budget)}`, { bookingId: booking.id }).catch(() => {});
    }

    res.status(201).json({ booking: await customerView(booking.id), notified: recipients.length });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------- reads

async function listMyBookings(req, res, next) {
  try {
    const asArtisan = req.user.role === "ARTISAN" && req.user.artisanProfile;
    const where = asArtisan
      ? { artisanId: req.user.artisanProfile.id, NOT: { status: "REQUESTED" } }
      : { customerId: req.user.id };
    const bookings = await prisma.booking.findMany({ where, include: asArtisan ? JOB_VIEW : CUSTOMER_VIEW, orderBy: { createdAt: "desc" } });
    res.json({ bookings });
  } catch (err) {
    next(err);
  }
}

// Requests an artisan can respond to right now. Offline artisans get none.
async function listOpenBookings(req, res, next) {
  try {
    const me = req.user.artisanProfile;
    if (!me) return res.status(403).json({ error: "No artisan profile found." });
    const profile = await prisma.artisanProfile.findUnique({ where: { id: me.id }, select: { isAvailable: true, isVerified: true } });
    if (!profile.isAvailable || !profile.isVerified) return res.json({ bookings: [], online: profile.isAvailable });

    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: OPEN },
        category: { in: [me.category, OTHERS] },
        customerId: { not: req.user.id },
        OR: [{ artisanId: null }, { artisanId: me.id }],
        offers: { none: { artisanId: me.id, status: { in: ["DECLINED", "REJECTED", "CLOSED"] } } },
      },
      include: { ...REQUEST_VIEW, offers: { where: { artisanId: me.id } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      online: true,
      bookings: bookings.map(({ offers, ...b }) => ({ ...b, myOffer: offers[0] || null })),
    });
  } catch (err) {
    next(err);
  }
}

// The one booking to resume after a refresh: the customer's latest open
// booking, or the artisan's current job.
async function getActiveBooking(req, res, next) {
  try {
    const me = req.user.artisanProfile;
    if (req.user.role === "ARTISAN" && me) {
      const job = await prisma.booking.findFirst({
        where: { artisanId: me.id, status: { in: ["ACCEPTED", "PAID", "IN_PROGRESS", "COMPLETED"] } },
        include: JOB_VIEW,
        orderBy: { acceptedAt: "desc" },
      });
      return res.json({ booking: job });
    }
    const booking = await prisma.booking.findFirst({
      where: { customerId: req.user.id, status: { in: ACTIVE } },
      include: CUSTOMER_VIEW,
      orderBy: { createdAt: "desc" },
    });
    res.json({ booking });
  } catch (err) {
    next(err);
  }
}

async function getBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: CUSTOMER_VIEW });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.customerId === req.user.id) return res.json({ booking });

    const me = req.user.artisanProfile;
    if (me && booking.artisanId === me.id && booking.status !== "REQUESTED") {
      return res.json({ booking: await prisma.booking.findUnique({ where: { id: booking.id }, include: JOB_VIEW }) });
    }
    if (me && booking.status === "REQUESTED" && categoryMatches(booking.category, me.category) && (!booking.artisanId || booking.artisanId === me.id)) {
      return res.json({ booking: await requestViewFor(booking.id, me.id) });
    }
    res.status(403).json({ error: "Not your booking." });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------- matching

// Gives the job to one artisan at an agreed price (or Price on Hold). Runs
// in a transaction guarded on status so two accepts can't both win.
async function matchBooking(sock, bookingId, artisanId, { priceKobo, hold }) {
  const matched = await prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw httpError(404, "Booking not found.");
    if (booking.status !== "REQUESTED") throw httpError(409, "This request has already been taken or cancelled.");
    if (booking.artisanId && booking.artisanId !== artisanId) throw httpError(403, "This request was sent to another artisan.");

    const data = { artisanId, status: "ACCEPTED", acceptedAt: new Date(), priceOnHold: !!hold };
    if (!hold) {
      data.escrowKobo = await settleEscrow(tx, booking, priceKobo);
      data.agreedPriceKobo = priceKobo;
    }
    await tx.bookingOffer.upsert({
      where: { bookingId_artisanId: { bookingId, artisanId } },
      create: { bookingId, artisanId, priceKobo: hold ? null : priceKobo, isHold: !!hold, status: "ACCEPTED" },
      update: { status: "ACCEPTED", ...(hold ? {} : { priceKobo }) },
    });
    await tx.bookingOffer.updateMany({ where: { bookingId, artisanId: { not: artisanId }, status: "PENDING" }, data: { status: "CLOSED" } });
    return tx.booking.update({ where: { id: bookingId }, data, include: JOB_VIEW });
  });

  await prisma.chatThread.upsert({
    where: { bookingId: matched.id },
    create: { bookingId: matched.id, participants: { create: [{ userId: matched.customerId }, { userId: matched.artisan.userId }] } },
    update: {},
  });

  pushToCustomer(sock, await customerView(matched.id));
  pushJobToArtisan(sock, matched);
  await closeRequestForArtisans(sock, matched, matched.artisanId);

  const who = matched.artisan.user.name;
  notify(sock, matched.customerId, "BOOKING", hold ? "Price on Hold accepted" : "Price agreed!",
    hold ? `${who} is coming to assess your ${matched.category} job.` : `${who} will do your ${matched.category} job for ${naira(priceKobo)}.`, { bookingId: matched.id }).catch(() => {});
  notify(sock, matched.artisan.userId, "BOOKING", "You got the job!",
    hold ? `Head to ${matched.address} to assess the job.` : `${matched.category} for ${naira(priceKobo)} — head to ${matched.address}.`, { bookingId: matched.id }).catch(() => {});
  return matched;
}

// Artisan responds to a request: accept the customer's price, send their own
// price, offer Price on Hold, or decline.
async function artisanRespond(req, res, next) {
  try {
    const me = req.user.artisanProfile;
    if (!me) return res.status(403).json({ error: "No artisan profile found." });
    const { action } = req.body;
    const priceKobo = Number(req.body.priceKobo);

    const profile = await prisma.artisanProfile.findUnique({ where: { id: me.id }, select: { isAvailable: true, isVerified: true } });
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Request not found." });
    if (booking.status !== "REQUESTED") return res.status(409).json({ error: "This request is no longer open." });
    if (!categoryMatches(booking.category, me.category)) return res.status(403).json({ error: "This request isn't in your category." });
    if (booking.artisanId && booking.artisanId !== me.id) return res.status(403).json({ error: "This request was sent to another artisan." });
    if (booking.customerId === req.user.id) return res.status(400).json({ error: "You can't respond to your own request." });

    const key = { bookingId_artisanId: { bookingId: booking.id, artisanId: me.id } };
    const existing = await prisma.bookingOffer.findUnique({ where: key });
    if (existing && ["DECLINED", "REJECTED", "CLOSED"].includes(existing.status)) {
      return res.status(409).json({ error: "This request is closed for you." });
    }

    if (action === "decline") {
      await prisma.bookingOffer.upsert({ where: key, create: { bookingId: booking.id, artisanId: me.id, status: "DECLINED" }, update: { status: "DECLINED" } });
      pushToCustomer(io(req), await customerView(booking.id));
      if (booking.artisanId) {
        notify(io(req), booking.customerId, "BOOKING", "Request declined", `${req.user.name} can't take this job. You can cancel and book someone else.`, { bookingId: booking.id }).catch(() => {});
      }
      return res.json({ declined: true });
    }

    if (!profile.isAvailable) return res.status(409).json({ error: "Go online to respond to requests." });
    if (!profile.isVerified) return res.status(403).json({ error: "Your account is awaiting verification." });

    if (action === "accept") {
      // The price on the table for this artisan: the customer's counter to
      // them if there is one, otherwise the customer's budget.
      const price = existing && existing.lastBy === "CUSTOMER" && existing.customerPriceKobo ? existing.customerPriceKobo : booking.priceKobo;
      const job = await matchBooking(io(req), booking.id, me.id, { priceKobo: price, hold: false });
      return res.json({ booking: job });
    }

    if (action === "price" || action === "hold") {
      if (action === "price" && (!priceKobo || priceKobo < MIN_PRICE_KOBO)) {
        return res.status(400).json({ error: `Enter a price of at least ${naira(MIN_PRICE_KOBO)}.` });
      }
      const data = action === "hold"
        ? { isHold: true, priceKobo: null, lastBy: "ARTISAN", status: "PENDING" }
        : { isHold: false, priceKobo, lastBy: "ARTISAN", status: "PENDING" };
      await prisma.bookingOffer.upsert({ where: key, create: { bookingId: booking.id, artisanId: me.id, ...data }, update: data });
      pushToCustomer(io(req), await customerView(booking.id));
      notify(io(req), booking.customerId, "BOOKING", action === "hold" ? "Price on Hold offer" : "New price offer",
        action === "hold" ? `${req.user.name} wants to assess your ${booking.category} job before giving a price.` : `${req.user.name} offers ${naira(priceKobo)} for your ${booking.category} job.`,
        { bookingId: booking.id }).catch(() => {});
      return res.json({ booking: await requestViewFor(booking.id, me.id) });
    }

    res.status(400).json({ error: "Choose accept, price, hold or decline." });
  } catch (err) {
    next(err);
  }
}

// Customer responds to one artisan's offer: accept, counter with their own
// price, or reject.
async function customerRespond(req, res, next) {
  try {
    const { action } = req.body;
    const priceKobo = Number(req.body.priceKobo);
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.customerId !== req.user.id) return res.status(403).json({ error: "Not your booking." });
    if (booking.status !== "REQUESTED") return res.status(409).json({ error: "This request is no longer open." });

    const offer = await prisma.bookingOffer.findUnique({ where: { id: req.params.offerId }, include: { artisan: { select: { id: true, userId: true, user: { select: { name: true } } } } } });
    if (!offer || offer.bookingId !== booking.id || offer.status !== "PENDING") return res.status(404).json({ error: "That offer is no longer available." });
    const who = firstName(offer.artisan.user.name);

    if (action === "accept") {
      if (offer.lastBy !== "ARTISAN") return res.status(409).json({ error: `Waiting for ${who} to reply to your price.` });
      await matchBooking(io(req), booking.id, offer.artisanId, { priceKobo: offer.priceKobo, hold: offer.isHold });
      return res.json({ booking: await customerView(booking.id) });
    }

    if (action === "counter") {
      if (offer.isHold) return res.status(400).json({ error: `${who} needs to see the job first. Accept Price on Hold or decline it.` });
      if (!priceKobo || priceKobo < MIN_PRICE_KOBO) return res.status(400).json({ error: `Enter a price of at least ${naira(MIN_PRICE_KOBO)}.` });
      await prisma.bookingOffer.update({ where: { id: offer.id }, data: { customerPriceKobo: priceKobo, lastBy: "CUSTOMER" } });
      await pushRequestToArtisan(io(req), booking.id, offer.artisan);
      notify(io(req), offer.artisan.userId, "BOOKING", "Customer sent a price", `The customer offers ${naira(priceKobo)} for the ${booking.category} job.`, { bookingId: booking.id }).catch(() => {});
      return res.json({ booking: await customerView(booking.id) });
    }

    if (action === "reject") {
      await prisma.bookingOffer.update({ where: { id: offer.id }, data: { status: "REJECTED" } });
      io(req)?.to(`user:${offer.artisan.userId}`).emit("request:closed", { bookingId: booking.id });
      return res.json({ booking: await customerView(booking.id) });
    }

    res.status(400).json({ error: "Choose accept, counter or reject." });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------- cancel

// Either side can cancel until a price is agreed; the escrow goes back to
// the customer's wallet. Once a price is agreed the job can't be cancelled
// in the app.
async function cancelBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: JOB_VIEW });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isOwner = booking.customerId === req.user.id;
    const isArtisan = req.user.artisanProfile && booking.artisanId === req.user.artisanProfile.id && booking.status !== "REQUESTED";
    if (!isOwner && !isArtisan) return res.status(403).json({ error: "Not your booking." });

    const cancellable = booking.status === "REQUESTED" || (booking.status === "ACCEPTED" && booking.agreedPriceKobo == null);
    if (!cancellable) {
      return res.status(409).json({ error: "The price has been agreed, so this job can't be cancelled in the app. Contact support if there's a problem." });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const fresh = await tx.booking.findUnique({ where: { id: booking.id } });
      if (fresh.status !== booking.status) throw httpError(409, "This booking just changed. Refresh and try again.");
      if (fresh.corporatePlanId) {
        if (fresh.escrowKobo > 0) await corporate.creditPlan(tx, fresh.corporatePlanId, fresh.escrowKobo);
        await tx.corporatePlan.update({ where: { id: fresh.corporatePlanId }, data: { callsUsed: { decrement: 1 } } });
      } else if (fresh.escrowKobo > 0) {
        await wallet.creditWallet(fresh.customerId, fresh.escrowKobo, "ESCROW_REFUND", {
          bookingId: fresh.id,
          reference: generateReference("REF"),
          description: `Escrow refunded — ${fresh.category} request cancelled`,
        }, tx);
      }
      await tx.bookingOffer.updateMany({ where: { bookingId: fresh.id, status: { in: ["PENDING", "ACCEPTED"] } }, data: { status: "CLOSED" } });
      return tx.booking.update({
        where: { id: fresh.id },
        data: { status: "CANCELLED", cancelledAt: new Date(), escrowKobo: 0, cancelReason: req.body?.reason || (isOwner ? "Cancelled by customer" : "Cancelled by artisan") },
        include: JOB_VIEW,
      });
    });

    pushToCustomer(io(req), await customerView(updated.id));
    pushJobToArtisan(io(req), updated);
    await closeRequestForArtisans(io(req), updated);
    if (isOwner && updated.artisan) {
      notify(io(req), updated.artisan.userId, "BOOKING", "Job cancelled", `The customer cancelled the ${updated.category} job.`, { bookingId: updated.id }).catch(() => {});
    }
    if (isArtisan) {
      notify(io(req), updated.customerId, "BOOKING", "Artisan cancelled", `${req.user.name} cancelled. Your escrow of ${naira(booking.escrowKobo)} is back in your wallet.`, { bookingId: updated.id }).catch(() => {});
    }
    res.json({ booking: isOwner ? await customerView(updated.id) : updated });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------- job stages

async function loadOwnJob(req) {
  const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
  if (!booking) throw httpError(404, "Booking not found.");
  if (!req.user.artisanProfile || booking.artisanId !== req.user.artisanProfile.id) throw httpError(403, "Not your job.");
  return booking;
}

async function publishJob(req, id) {
  const job = await prisma.booking.findUnique({ where: { id }, include: JOB_VIEW });
  pushToCustomer(io(req), await customerView(id));
  pushJobToArtisan(io(req), job);
  return job;
}

async function arriveBooking(req, res, next) {
  try {
    const booking = await loadOwnJob(req);
    if (!["ACCEPTED", "PAID"].includes(booking.status)) return res.status(409).json({ error: "You can only check in before the job starts." });
    await prisma.booking.update({ where: { id: booking.id }, data: { arrivedAt: new Date() } });
    notify(io(req), booking.customerId, "BOOKING", "Artisan has arrived", booking.priceOnHold && booking.agreedPriceKobo == null
      ? "Your artisan is at your place to assess the job and agree a price."
      : "Your artisan is at your place.", { bookingId: booking.id }).catch(() => {});
    res.json({ booking: await publishJob(req, booking.id) });
  } catch (err) {
    next(err);
  }
}

// Price on Hold: after assessing on site, the artisan submits the price they
// agreed with the customer for the customer to accept in the app.
async function submitOnsitePrice(req, res, next) {
  try {
    const booking = await loadOwnJob(req);
    const priceKobo = Number(req.body.priceKobo);
    if (booking.status !== "ACCEPTED" || !booking.priceOnHold || booking.agreedPriceKobo != null) {
      return res.status(409).json({ error: "There's no price to submit for this job." });
    }
    if (!booking.arrivedAt) return res.status(409).json({ error: "Check in at the customer's place first." });
    if (!priceKobo || priceKobo < MIN_PRICE_KOBO) return res.status(400).json({ error: `Enter a price of at least ${naira(MIN_PRICE_KOBO)}.` });
    await prisma.booking.update({ where: { id: booking.id }, data: { onsitePriceKobo: priceKobo } });
    notify(io(req), booking.customerId, "BOOKING", "Price submitted", `Your artisan submitted ${naira(priceKobo)}. Accept it in the app to start the job.`, { bookingId: booking.id }).catch(() => {});
    res.json({ booking: await publishJob(req, booking.id) });
  } catch (err) {
    next(err);
  }
}

async function respondOnsitePrice(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: JOB_VIEW });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.customerId !== req.user.id) return res.status(403).json({ error: "Not your booking." });
    if (booking.status !== "ACCEPTED" || booking.onsitePriceKobo == null || booking.agreedPriceKobo != null) {
      return res.status(409).json({ error: "There's no submitted price to answer." });
    }

    if (req.body.action === "accept") {
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.booking.findUnique({ where: { id: booking.id } });
        const escrowKobo = await settleEscrow(tx, fresh, fresh.onsitePriceKobo);
        await tx.booking.update({ where: { id: booking.id }, data: { agreedPriceKobo: fresh.onsitePriceKobo, escrowKobo } });
      });
      notify(io(req), booking.artisan.userId, "BOOKING", "Price accepted", `The customer accepted ${naira(booking.onsitePriceKobo)}. You can start the job.`, { bookingId: booking.id }).catch(() => {});
    } else if (req.body.action === "reject") {
      await prisma.booking.update({ where: { id: booking.id }, data: { onsitePriceKobo: null } });
      notify(io(req), booking.artisan.userId, "BOOKING", "Price not accepted", "The customer didn't accept that price. Agree a new one and submit it again.", { bookingId: booking.id }).catch(() => {});
    } else {
      return res.status(400).json({ error: "Choose accept or reject." });
    }
    await publishJob(req, booking.id);
    res.json({ booking: await customerView(booking.id) });
  } catch (err) {
    next(err);
  }
}

async function startBooking(req, res, next) {
  try {
    const booking = await loadOwnJob(req);
    if (!["ACCEPTED", "PAID"].includes(booking.status)) return res.status(409).json({ error: "This job can't be started now." });
    if (booking.agreedPriceKobo == null) return res.status(409).json({ error: "Agree the price with the customer before starting." });
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "IN_PROGRESS", startedAt: new Date(), arrivedAt: booking.arrivedAt || new Date() } });
    notify(io(req), booking.customerId, "BOOKING", "Work started", `Your ${booking.category} job is in progress.`, { bookingId: booking.id }).catch(() => {});
    res.json({ booking: await publishJob(req, booking.id) });
  } catch (err) {
    next(err);
  }
}

// Finishing moves the escrow into payout holds (artisan share + platform
// commission), released when the customer confirms or after the window.
async function completeBooking(req, res, next) {
  try {
    const booking = await loadOwnJob(req);
    if (booking.status !== "IN_PROGRESS") return res.status(409).json({ error: "Start the job before marking it done." });
    await prisma.$transaction(async (tx) => {
      const holds = await tx.escrowHold.count({ where: { bookingId: booking.id } });
      if (!holds) {
        await escrow.createHoldsForBooking({ bookingId: booking.id, payerId: booking.customerId, payeeId: req.user.id, priceKobo: booking.agreedPriceKobo }, tx);
      }
      await tx.booking.update({ where: { id: booking.id }, data: { status: "COMPLETED", completedAt: new Date(), escrowKobo: 0 } });
    });
    notify(io(req), booking.customerId, "BOOKING", "Job marked done", "Check the work and confirm to release payment to your artisan.", { bookingId: booking.id }).catch(() => {});
    res.json({ booking: await publishJob(req, booking.id) });
  } catch (err) {
    next(err);
  }
}

// Customer confirms — releases escrow to the artisan (minus commission) and
// bumps the artisan's jobsDone counter.
async function confirmBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.customerId !== req.user.id) return res.status(403).json({ error: "Not your booking." });
    if (booking.status !== "COMPLETED") return res.status(409).json({ error: "The artisan hasn't marked this job done yet." });

    await escrow.releaseAllHoldsForBooking(booking.id, { reference: generateReference("REL"), description: `Released for booking ${booking.id}` });
    await prisma.$transaction(async (tx) => {
      if (booking.artisanId) await tx.artisanProfile.update({ where: { id: booking.artisanId }, data: { jobsDone: { increment: 1 } } });
      const { count } = await tx.booking.updateMany({ where: { id: booking.id, status: "COMPLETED" }, data: { status: "CONFIRMED", confirmedAt: new Date() } });
      if (!count) throw httpError(409, "This job just changed. Refresh and try again.");
    });
    const job = await publishJob(req, booking.id);
    notify(io(req), job.artisan.userId, "PAYMENT", "Payment released", `You've been paid for the ${job.category} job.`, { bookingId: job.id }).catch(() => {});
    res.json({ booking: await customerView(booking.id) });
  } catch (err) {
    next(err);
  }
}

// A COMPLETED booking whose customer never explicitly confirms still has
// its escrow released by the auto-release sweep (escrow.service) — this
// closes the booking itself out to CONFIRMED once that's happened, so it
// doesn't sit at COMPLETED forever even though the money already moved.
// Called from the same periodic sweep in realtime/live.js.
async function finalizeAutoReleasedBookings(sock) {
  const candidates = await prisma.booking.findMany({
    where: { status: "COMPLETED", escrowHolds: { some: {} }, NOT: { escrowHolds: { some: { status: "HELD" } } } },
    include: JOB_VIEW,
  });
  for (const booking of candidates) {
    if (booking.artisanId) {
      await prisma.artisanProfile.update({ where: { id: booking.artisanId }, data: { jobsDone: { increment: 1 } } });
    }
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED", confirmedAt: new Date() } });
    pushToCustomer(sock, await customerView(booking.id));
    pushJobToArtisan(sock, { ...booking, status: "CONFIRMED" });
  }
  return candidates.length;
}

// ---------------------------------------------------------------- disputes

// "Job not completed", as in Handa: before the money is released the
// customer can freeze it. The booking moves to DISPUTED, the payout holds
// stop counting down, and a dispute ticket goes to admins. The artisan can
// add their side once; an admin then releases, refunds or splits.
const DISPUTE_REASONS = ["Job not completed", "Poor quality work", "Artisan didn't show up", "Damage to property", "Overcharged", "Other"];

function disputeFor(bookingId) {
  return prisma.supportTicket.findFirst({ where: { bookingId, isDispute: true }, orderBy: { createdAt: "desc" } });
}

async function openDispute(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: JOB_VIEW });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.customerId !== req.user.id) return res.status(403).json({ error: "Not your booking." });
    if (booking.status === "DISPUTED") return res.status(409).json({ error: "This job is already under review." });
    if (booking.status !== "COMPLETED") {
      return res.status(409).json({ error: booking.status === "CONFIRMED"
        ? "Payment for this job has already been released. Use Report an Issue and support will help."
        : "You can report a job as not completed once the artisan marks it done." });
    }
    const reason = DISPUTE_REASONS.includes(req.body?.reason) ? req.body.reason : "Job not completed";
    const details = String(req.body?.details || "").trim();
    if (details.length < 5) return res.status(400).json({ error: "Tell us briefly what went wrong." });
    const held = (await prisma.escrowHold.findMany({ where: { bookingId: booking.id, status: "HELD" } })).reduce((n, h) => n + h.amountKobo, 0);
    let requestedRefundKobo = req.body?.requestedRefundKobo == null || req.body.requestedRefundKobo === "" ? null : Math.round(Number(req.body.requestedRefundKobo));
    if (requestedRefundKobo != null && (!Number.isFinite(requestedRefundKobo) || requestedRefundKobo <= 0)) requestedRefundKobo = null;
    if (requestedRefundKobo != null) requestedRefundKobo = Math.min(requestedRefundKobo, held);

    const ticket = await prisma.$transaction(async (tx) => {
      const frozen = await escrow.freezeHoldsForBooking(booking.id, tx);
      if (!frozen) throw httpError(409, "Payment for this job has just been released. Use Report an Issue and support will help.");
      await tx.booking.update({ where: { id: booking.id }, data: { status: "DISPUTED" } });
      return tx.supportTicket.create({
        data: {
          userId: req.user.id,
          bookingId: booking.id,
          isDispute: true,
          category: reason,
          subject: `${reason} — ${booking.category} job`,
          message: details,
          evidenceUrl: req.body?.evidenceUrl || null,
          requestedRefundKobo,
          secondPartyUserId: booking.artisan?.userId || null,
        },
      });
    });

    await publishJob(req, booking.id);
    if (booking.artisan) {
      notify(io(req), booking.artisan.userId, "BOOKING", "Payment on hold", `${firstName(req.user.name)} reported "${reason}" for the ${booking.category} job. Your payment is held until FixMi reviews it — add your side now.`, { bookingId: booking.id }).catch(() => {});
    }
    notify(io(req), req.user.id, "BOOKING", "Payment held in escrow", "Your money stays in escrow while FixMi reviews the job. We'll update you here.", { bookingId: booking.id }).catch(() => {});
    notifyAllAdmins(io(req), "⚖️ New dispute", `${reason} — ${booking.category} job, ${naira(held)} held`, { bookingId: booking.id, ticketId: ticket.id }).catch(() => {});
    res.status(201).json({ ticket, booking: await customerView(booking.id) });
  } catch (err) {
    next(err);
  }
}

async function getDispute(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { artisan: { select: { userId: true } } } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const allowed = booking.customerId === req.user.id || booking.artisan?.userId === req.user.id || req.user.role === "ADMIN";
    if (!allowed) return res.status(403).json({ error: "Not your booking." });
    const holds = await prisma.escrowHold.findMany({ where: { bookingId: booking.id, status: "DISPUTED" } });
    res.json({ dispute: await disputeFor(booking.id), heldKobo: holds.reduce((n, h) => n + h.amountKobo, 0) });
  } catch (err) {
    next(err);
  }
}

async function respondDispute(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { artisan: { select: { userId: true } } } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.artisan?.userId !== req.user.id) return res.status(403).json({ error: "Not your job." });
    const ticket = await disputeFor(booking.id);
    if (!ticket || ticket.resolvedAt) return res.status(409).json({ error: "There is no open dispute on this job." });
    if (ticket.secondPartyRespondedAt) return res.status(409).json({ error: "You've already sent your side." });
    const response = String(req.body?.response || "").trim();
    if (response.length < 5) return res.status(400).json({ error: "Tell us your side of what happened." });
    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { secondPartyResponse: response, secondPartyEvidenceUrl: req.body?.evidenceUrl || null, secondPartyRespondedAt: new Date(), status: "IN_REVIEW" },
    });
    notifyAllAdmins(io(req), "⚖️ Artisan responded", `${req.user.name} replied to a dispute`, { bookingId: booking.id, ticketId: ticket.id }).catch(() => {});
    notify(io(req), booking.customerId, "BOOKING", "Artisan responded", "Your artisan has added their side. FixMi will decide shortly.", { bookingId: booking.id }).catch(() => {});
    await publishJob(req, booking.id);
    res.json({ dispute: updated });
  } catch (err) {
    next(err);
  }
}

// Admin decision. Moves the booking out of DISPUTED: CONFIRMED when the
// artisan was paid anything, CANCELLED on a full refund.
async function resolveDispute(req, res, next) {
  try {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.ticketId } });
    if (!ticket || !ticket.isDispute) return res.status(404).json({ error: "Dispute not found." });
    if (ticket.resolvedAt) return res.status(409).json({ error: "This dispute is already resolved." });
    const outcome = String(req.body?.outcome || "").toUpperCase();
    const refundKobo = req.body?.refundKobo != null ? Number(req.body.refundKobo) : 0;
    const result = await escrow.resolveDisputedHolds(ticket.bookingId, outcome, refundKobo);
    const note = String(req.body?.note || "").trim();
    const booking = await prisma.booking.findUnique({ where: { id: ticket.bookingId } });
    const paid = result.payoutKobo > 0;
    await prisma.$transaction(async (tx) => {
      if (paid && booking.artisanId) await tx.artisanProfile.update({ where: { id: booking.artisanId }, data: { jobsDone: { increment: 1 } } });
      await tx.booking.update({
        where: { id: booking.id },
        data: paid ? { status: "CONFIRMED", confirmedAt: new Date() } : { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Refunded after dispute review" },
      });
      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolution: outcome + (note ? ` — ${note}` : ""), refundAmountKobo: result.refundKobo },
      });
    });
    const job = await publishJob(req, booking.id);
    const summary = outcome === "RELEASE" ? "Payment released to the artisan."
      : outcome === "REFUND" ? `${naira(result.refundKobo)} refunded to the customer.`
      : `${naira(result.refundKobo)} refunded to the customer, ${naira(result.payoutKobo)} paid to the artisan.`;
    notify(io(req), booking.customerId, "BOOKING", "Dispute resolved", summary + (note ? ` ${note}` : ""), { bookingId: booking.id }).catch(() => {});
    if (job.artisan) notify(io(req), job.artisan.userId, "BOOKING", "Dispute resolved", summary + (note ? ` ${note}` : ""), { bookingId: booking.id }).catch(() => {});
    logAdminAction(req.user, "DISPUTE_" + outcome, "SupportTicket", ticket.id, summary);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function listDisputes(req, res, next) {
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { isDispute: true, ...(req.query.open === "false" ? {} : { resolvedAt: null }) },
      include: { user: { select: { id: true, name: true, phone: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const ids = tickets.map((t) => t.bookingId).filter(Boolean);
    const bookings = await prisma.booking.findMany({ where: { id: { in: ids } }, include: { ...JOB_VIEW, escrowHolds: true } });
    const byId = Object.fromEntries(bookings.map((b) => [b.id, b]));
    res.json({ disputes: tickets.map((t) => ({ ...t, booking: byId[t.bookingId] || null })) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  openDispute,
  getDispute,
  respondDispute,
  resolveDispute,
  listDisputes,
  DISPUTE_REASONS,
  createBooking,
  listMyBookings,
  listOpenBookings,
  getActiveBooking,
  getBooking,
  artisanRespond,
  customerRespond,
  cancelBooking,
  arriveBooking,
  submitOnsitePrice,
  respondOnsitePrice,
  startBooking,
  completeBooking,
  confirmBooking,
  finalizeAutoReleasedBookings,
};
