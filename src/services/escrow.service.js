const prisma = require("../config/db");
const wallet = require("./wallet.service");
const { commissionPercent } = require("../config/money");
const { generateReference } = require("../utils/reference");

// How long the customer has to confirm (or report "Job not completed")
// after the artisan marks a job done before the money is released anyway.
function autoReleaseMinutes() {
  const n = Number(process.env.ESCROW_AUTO_RELEASE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

// A booking is paid into escrow up front (real money already collected from
// the customer via Paystack/wallet) and only credited to the artisan's
// withdrawable Wallet once released. Two holds per paid booking: one for
// the artisan (payeeId set), one for the platform's commission cut
// (payeeId null) — created together in createHoldsForBooking so releasing/
// refunding a booking always resolves both consistently.
async function createHold({ bookingId, payerId, payeeId, amountKobo, autoRelease = true }, tx = prisma) {
  if (amountKobo <= 0) throw Object.assign(new Error("Escrow amount must be positive."), { status: 400 });
  return tx.escrowHold.create({
    data: {
      bookingId,
      payerId,
      payeeId,
      amountKobo,
      autoReleaseAt: autoRelease ? new Date(Date.now() + autoReleaseMinutes() * 60 * 1000) : null,
    },
  });
}

// Splits a booking's price into the artisan's hold and the platform's
// commission hold at payment time, so the split is fixed at the price the
// customer actually paid rather than recomputed later at release time.
async function createHoldsForBooking({ bookingId, payerId, payeeId, priceKobo }, tx = prisma) {
  const commissionKobo = Math.round((priceKobo * commissionPercent()) / 100);
  const artisanKobo = priceKobo - commissionKobo;
  const artisanHold = await createHold({ bookingId, payerId, payeeId, amountKobo: artisanKobo }, tx);
  const platformHold = commissionKobo > 0 ? await createHold({ bookingId, payerId, payeeId: null, amountKobo: commissionKobo, autoRelease: true }, tx) : null;
  return { artisanHold, platformHold };
}

async function releaseHold(holdId, { reference, description, fromDisputed = false } = {}) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw Object.assign(new Error("Escrow hold not found."), { status: 404 });
    if (hold.status !== "HELD" && !(fromDisputed && hold.status === "DISPUTED")) throw Object.assign(new Error(`Escrow hold is already ${hold.status.toLowerCase()}.`), { status: 409 });

    if (hold.payeeId) {
      await wallet.creditWallet(hold.payeeId, hold.amountKobo, "PAYOUT", { bookingId: hold.bookingId, reference, description }, tx);
    }
    // A null payeeId is the platform's own commission cut — releasing it is
    // just bookkeeping, the money never left the platform's balance.

    // Conditional on the status we read, so a "Job not completed" freeze
    // that lands mid-release rolls this release back instead of paying out.
    const { count } = await tx.escrowHold.updateMany({ where: { id: holdId, status: hold.status }, data: { status: "RELEASED", releasedAt: new Date() } });
    if (!count) throw Object.assign(new Error("Escrow hold changed while releasing."), { status: 409 });
    return { ...hold, status: "RELEASED" };
  });
}

async function releaseAllHoldsForBooking(bookingId, opts = {}) {
  const holds = await prisma.escrowHold.findMany({ where: { bookingId, status: "HELD" } });
  const released = [];
  for (const hold of holds) released.push(await releaseHold(hold.id, opts));
  return released;
}

// Cancellations refund the payer as wallet credit (in-app store credit)
// rather than reversing the original Paystack charge — simpler, and
// matches how most Nigerian marketplace apps handle this. The platform's
// own commission hold has no payer credit to reverse into a wallet it
// never left, so it's simply marked refunded (no-op transfer).
async function refundHold(holdId, { reference, description, fromDisputed = false } = {}) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw Object.assign(new Error("Escrow hold not found."), { status: 404 });
    if (hold.status !== "HELD" && !(fromDisputed && hold.status === "DISPUTED")) throw Object.assign(new Error(`Escrow hold is already ${hold.status.toLowerCase()}.`), { status: 409 });

    await wallet.creditWallet(hold.payerId, hold.amountKobo, "ESCROW_REFUND", { bookingId: hold.bookingId, reference, description }, tx);

    const { count } = await tx.escrowHold.updateMany({ where: { id: holdId, status: hold.status }, data: { status: "REFUNDED", refundedAt: new Date() } });
    if (!count) throw Object.assign(new Error("Escrow hold changed while refunding."), { status: 409 });
    return { ...hold, status: "REFUNDED" };
  });
}

async function refundAllHoldsForBooking(bookingId, opts = {}) {
  const holds = await prisma.escrowHold.findMany({ where: { bookingId, status: "HELD" } });
  const refunded = [];
  for (const hold of holds) refunded.push(await refundHold(hold.id, opts));
  return refunded;
}

// Called by a scheduled sweep (see realtime/live.js) to release any hold
// whose autoReleaseAt has passed and the customer never explicitly
// confirmed — must be server-side, not a client setTimeout, since a closed
// browser tab must not block an artisan from getting paid.
async function runAutoReleaseSweep() {
  const due = await prisma.escrowHold.findMany({ where: { status: "HELD", autoReleaseAt: { lte: new Date() } } });
  for (const hold of due) {
    await releaseHold(hold.id, { description: "Auto-released after the escrow window elapsed." }).catch((err) => {
      if (err.status !== 409) throw err;
    });
  }
  return due.length;
}

// "Job not completed": freeze every still-held payout for the booking so
// the sweep above skips it. Returns how many holds were frozen — 0 means
// the money had already been released and there is nothing to dispute.
async function freezeHoldsForBooking(bookingId, tx = prisma) {
  const { count } = await tx.escrowHold.updateMany({ where: { bookingId, status: "HELD" }, data: { status: "DISPUTED", autoReleaseAt: null } });
  return count;
}

// Admin decision on a disputed booking. RELEASE pays the artisan as normal,
// REFUND returns everything to the customer, SPLIT refunds `refundKobo` to
// the customer and pays the rest to the artisan with the usual commission
// taken from the artisan's part only.
async function resolveDisputedHolds(bookingId, outcome, refundKobo = 0) {
  const holds = await prisma.escrowHold.findMany({ where: { bookingId, status: "DISPUTED" } });
  if (!holds.length) throw Object.assign(new Error("There is no money held for this dispute."), { status: 409 });
  const totalKobo = holds.reduce((sum, h) => sum + h.amountKobo, 0);
  const opts = { reference: generateReference("DSP"), fromDisputed: true };

  if (outcome === "RELEASE") {
    for (const h of holds) await releaseHold(h.id, { ...opts, description: "Released after dispute review" });
    return { refundKobo: 0, payoutKobo: totalKobo };
  }
  if (outcome === "REFUND") {
    for (const h of holds) await refundHold(h.id, { ...opts, description: "Refunded after dispute review" });
    return { refundKobo: totalKobo, payoutKobo: 0 };
  }
  if (outcome !== "SPLIT") throw Object.assign(new Error("outcome must be RELEASE, REFUND or SPLIT."), { status: 400 });

  const refund = Math.round(Number(refundKobo));
  if (!Number.isFinite(refund) || refund <= 0 || refund >= totalKobo) {
    throw Object.assign(new Error("A split refund must be more than ₦0 and less than the amount held."), { status: 400 });
  }
  const payer = holds[0].payerId;
  const artisanHold = holds.find((h) => h.payeeId);
  const remainder = totalKobo - refund;
  const artisanKobo = remainder - Math.round((remainder * commissionPercent()) / 100);
  await prisma.$transaction(async (tx) => {
    await wallet.creditWallet(payer, refund, "ESCROW_REFUND", { bookingId, reference: opts.reference, description: "Part refund after dispute review" }, tx);
    if (artisanHold && artisanKobo > 0) {
      await wallet.creditWallet(artisanHold.payeeId, artisanKobo, "PAYOUT", { bookingId, reference: opts.reference, description: "Part payment after dispute review" }, tx);
    }
    await tx.escrowHold.updateMany({ where: { bookingId, status: "DISPUTED" }, data: { status: "RELEASED", releasedAt: new Date() } });
  });
  return { refundKobo: refund, payoutKobo: artisanKobo };
}

module.exports = {
  autoReleaseMinutes,
  freezeHoldsForBooking,
  resolveDisputedHolds,
  createHold,
  createHoldsForBooking,
  releaseHold,
  releaseAllHoldsForBooking,
  refundHold,
  refundAllHoldsForBooking,
  runAutoReleaseSweep,
};
