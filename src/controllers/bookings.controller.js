const prisma = require("../config/db");
const wallet = require("../services/wallet.service");
const escrow = require("../services/escrow.service");
const { notify } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");

const CUSTOMER_INCLUDE = {
  customer: { select: { id: true, name: true, avatarUrl: true, phone: true } },
  artisan: { select: { id: true, category: true, bizName: true, ratingAvg: true, user: { select: { id: true, name: true, avatarUrl: true, phone: true } } } },
};

function io(req) {
  return req.app.get("io");
}

// A customer submits a job request. It starts REQUESTED with no artisan
// assigned and is broadcast to every available, verified artisan in that
// category — matches the frontend's "radar" finding-artisan screen, which
// is really just waiting for the first accept to land.
async function createBooking(req, res, next) {
  try {
    const { category, issue, address, lat, lng, priceKobo, scheduledAt } = req.body;
    if (!category || !issue || !address || !priceKobo) {
      return res.status(400).json({ error: "category, issue, address, and priceKobo are required." });
    }
    if (Number(priceKobo) <= 0) return res.status(400).json({ error: "priceKobo must be positive." });

    const booking = await prisma.booking.create({
      data: {
        customerId: req.user.id,
        category,
        issue,
        address,
        lat: lat !== undefined ? Number(lat) : null,
        lng: lng !== undefined ? Number(lng) : null,
        priceKobo: Number(priceKobo),
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      },
      include: CUSTOMER_INCLUDE,
    });

    const candidates = await prisma.artisanProfile.findMany({
      where: { category, isAvailable: true, isVerified: true, kycStatus: "APPROVED" },
      select: { userId: true },
    });
    for (const c of candidates) {
      io(req)?.to(`user:${c.userId}`).emit("booking:new", booking);
      notify(io(req), c.userId, "BOOKING", "New job nearby", `${category}: ${issue}`, { bookingId: booking.id }).catch(() => {});
    }

    res.status(201).json({ booking });
  } catch (err) {
    next(err);
  }
}

async function listMyBookings(req, res, next) {
  try {
    const where =
      req.user.role === "ARTISAN" && req.user.artisanProfile
        ? { artisanId: req.user.artisanProfile.id }
        : { customerId: req.user.id };
    const bookings = await prisma.booking.findMany({ where, include: CUSTOMER_INCLUDE, orderBy: { createdAt: "desc" } });
    res.json({ bookings });
  } catch (err) {
    next(err);
  }
}

// Open job requests an available artisan of the matching category can
// still accept — the artisan-side "job alert" feed.
async function listOpenBookings(req, res, next) {
  try {
    if (!req.user.artisanProfile) return res.status(403).json({ error: "No artisan profile found." });
    const bookings = await prisma.booking.findMany({
      where: { status: "REQUESTED", category: req.user.artisanProfile.category },
      include: CUSTOMER_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    res.json({ bookings });
  } catch (err) {
    next(err);
  }
}

async function getBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: CUSTOMER_INCLUDE });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isOwner = booking.customerId === req.user.id;
    const isAssignedArtisan = req.user.artisanProfile && booking.artisanId === req.user.artisanProfile.id;
    if (!isOwner && !isAssignedArtisan && req.user.role !== "ADMIN") {
      return res.status(403).json({ error: "Not your booking." });
    }
    res.json({ booking });
  } catch (err) {
    next(err);
  }
}

// First artisan to accept wins — a transaction with a status guard so two
// simultaneous accepts can't both succeed against the same REQUESTED row.
async function acceptBooking(req, res, next) {
  try {
    if (!req.user.artisanProfile) return res.status(403).json({ error: "No artisan profile found." });

    const booking = await prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({ where: { id: req.params.id } });
      if (!current) throw Object.assign(new Error("Booking not found."), { status: 404 });
      if (current.status !== "REQUESTED") {
        throw Object.assign(new Error("This job has already been taken or is no longer available."), { status: 409 });
      }
      return tx.booking.update({
        where: { id: req.params.id },
        data: { artisanId: req.user.artisanProfile.id, status: "ACCEPTED", acceptedAt: new Date() },
        include: CUSTOMER_INCLUDE,
      });
    });

    const thread = await prisma.chatThread.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        participants: { create: [{ userId: booking.customerId }, { userId: req.user.id }] },
      },
      update: {},
    });

    io(req)?.to(`booking:${booking.id}`).emit("booking:updated", booking);
    io(req)?.to(`user:${booking.customerId}`).emit("booking:accepted", booking);
    notify(io(req), booking.customerId, "BOOKING", "Artisan found!", `${booking.artisan.user.name} accepted your ${booking.category} job.`, {
      bookingId: booking.id,
    }).catch(() => {});

    res.json({ booking, chatThreadId: thread.id });
  } catch (err) {
    next(err);
  }
}

async function declineBooking(req, res, next) {
  try {
    // Declining just means this artisan drops out — the booking stays
    // REQUESTED for everyone else, so nothing to update except telling the
    // dispatcher (no-op today, reserved for future per-artisan dispatch
    // tracking).
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// Customer pays the agreed price into escrow (wallet debit + hold split
// between artisan and platform commission). DEV_BYPASS_PAYMENTS lets this
// succeed without real funds during development/demo.
async function payBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { artisan: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.customerId !== req.user.id) return res.status(403).json({ error: "Not your booking." });
    if (booking.status !== "ACCEPTED") return res.status(409).json({ error: `Cannot pay a booking in status ${booking.status}.` });

    const reference = generateReference("PAY");
    const updated = await prisma.$transaction(async (tx) => {
      await wallet.debitWallet(booking.customerId, booking.priceKobo, "ESCROW_HOLD", { bookingId: booking.id, reference, description: `Payment for ${booking.category} job` }, tx);
      await escrow.createHoldsForBooking({ bookingId: booking.id, payerId: booking.customerId, payeeId: booking.artisan?.userId, priceKobo: booking.priceKobo }, tx);
      return tx.booking.update({ where: { id: booking.id }, data: { status: "PAID", paidAt: new Date() }, include: CUSTOMER_INCLUDE });
    });

    io(req)?.to(`booking:${booking.id}`).emit("booking:updated", updated);
    notify(io(req), updated.artisan.user.id, "PAYMENT", "Payment received", `Escrow funded for your ${updated.category} job. You can start work.`, {
      bookingId: updated.id,
    }).catch(() => {});

    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

async function startBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { artisan: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (!req.user.artisanProfile || booking.artisanId !== req.user.artisanProfile.id) return res.status(403).json({ error: "Not your job." });
    if (booking.status !== "PAID") return res.status(409).json({ error: `Cannot start a booking in status ${booking.status}.` });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "IN_PROGRESS", startedAt: new Date() }, include: CUSTOMER_INCLUDE });
    io(req)?.to(`booking:${booking.id}`).emit("booking:updated", updated);
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

async function completeBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (!req.user.artisanProfile || booking.artisanId !== req.user.artisanProfile.id) return res.status(403).json({ error: "Not your job." });
    if (booking.status !== "IN_PROGRESS") return res.status(409).json({ error: `Cannot complete a booking in status ${booking.status}.` });

    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "COMPLETED", completedAt: new Date() }, include: CUSTOMER_INCLUDE });
    io(req)?.to(`booking:${booking.id}`).emit("booking:updated", updated);
    notify(io(req), updated.customerId, "BOOKING", "Job marked complete", `Confirm the job is done to release payment to your artisan.`, {
      bookingId: updated.id,
    }).catch(() => {});
    res.json({ booking: updated });
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
    if (booking.status !== "COMPLETED") return res.status(409).json({ error: `Cannot confirm a booking in status ${booking.status}.` });

    await escrow.releaseAllHoldsForBooking(booking.id, { reference: generateReference("REL"), description: `Released for booking ${booking.id}` });
    const updated = await prisma.$transaction(async (tx) => {
      if (booking.artisanId) {
        await tx.artisanProfile.update({ where: { id: booking.artisanId }, data: { jobsDone: { increment: 1 } } });
      }
      return tx.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED", confirmedAt: new Date() }, include: CUSTOMER_INCLUDE });
    });

    io(req)?.to(`booking:${booking.id}`).emit("booking:updated", updated);
    notify(io(req), updated.artisan.user.id, "PAYMENT", "Payment released", `You've been paid for the ${updated.category} job.`, { bookingId: updated.id }).catch(() => {});
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// Cancellable before payment (nothing to refund) or after payment while
// still IN_PROGRESS/PAID (refunds the customer's escrow in full).
async function cancelBooking(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    const isOwner = booking.customerId === req.user.id;
    const isAssignedArtisan = req.user.artisanProfile && booking.artisanId === req.user.artisanProfile.id;
    if (!isOwner && !isAssignedArtisan) return res.status(403).json({ error: "Not your booking." });
    if (!["REQUESTED", "ACCEPTED", "PAID", "IN_PROGRESS"].includes(booking.status)) {
      return res.status(409).json({ error: `Cannot cancel a booking in status ${booking.status}.` });
    }

    if (["PAID", "IN_PROGRESS"].includes(booking.status)) {
      await escrow.refundAllHoldsForBooking(booking.id, { reference: generateReference("REF"), description: `Refund for cancelled booking ${booking.id}` });
    }

    const updated = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: req.body?.reason || null },
      include: CUSTOMER_INCLUDE,
    });

    io(req)?.to(`booking:${booking.id}`).emit("booking:updated", updated);
    res.json({ booking: updated });
  } catch (err) {
    next(err);
  }
}

// A COMPLETED booking whose customer never explicitly confirms still has
// its escrow released by the auto-release sweep (escrow.service) — this
// closes the booking itself out to CONFIRMED once that's happened, so it
// doesn't sit at COMPLETED forever even though the money already moved.
// Called from the same periodic sweep in realtime/live.js.
async function finalizeAutoReleasedBookings(io) {
  const candidates = await prisma.booking.findMany({
    where: { status: "COMPLETED", escrowHolds: { none: { status: "HELD" } } },
    include: CUSTOMER_INCLUDE,
  });
  for (const booking of candidates) {
    if (booking.artisanId) {
      await prisma.artisanProfile.update({ where: { id: booking.artisanId }, data: { jobsDone: { increment: 1 } } });
    }
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED", confirmedAt: new Date() }, include: CUSTOMER_INCLUDE });
    io?.to(`booking:${booking.id}`).emit("booking:updated", updated);
  }
  return candidates.length;
}

module.exports = {
  createBooking,
  listMyBookings,
  listOpenBookings,
  getBooking,
  acceptBooking,
  declineBooking,
  payBooking,
  startBooking,
  completeBooking,
  confirmBooking,
  cancelBooking,
  finalizeAutoReleasedBookings,
};
