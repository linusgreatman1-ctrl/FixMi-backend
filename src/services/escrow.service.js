const prisma = require("../config/db");
const wallet = require("./wallet.service");
const { commissionPercent } = require("../config/money");

const AUTO_RELEASE_HOURS = Number(process.env.ESCROW_AUTO_RELEASE_HOURS || 24);

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
      autoReleaseAt: autoRelease ? new Date(Date.now() + AUTO_RELEASE_HOURS * 60 * 60 * 1000) : null,
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

async function releaseHold(holdId, { reference, description } = {}) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw Object.assign(new Error("Escrow hold not found."), { status: 404 });
    if (hold.status !== "HELD") throw Object.assign(new Error(`Escrow hold is already ${hold.status.toLowerCase()}.`), { status: 409 });

    if (hold.payeeId) {
      await wallet.creditWallet(hold.payeeId, hold.amountKobo, "PAYOUT", { bookingId: hold.bookingId, reference, description }, tx);
    }
    // A null payeeId is the platform's own commission cut — releasing it is
    // just bookkeeping, the money never left the platform's balance.

    return tx.escrowHold.update({ where: { id: holdId }, data: { status: "RELEASED", releasedAt: new Date() } });
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
async function refundHold(holdId, { reference, description } = {}) {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (!hold) throw Object.assign(new Error("Escrow hold not found."), { status: 404 });
    if (hold.status !== "HELD") throw Object.assign(new Error(`Escrow hold is already ${hold.status.toLowerCase()}.`), { status: 409 });

    await wallet.creditWallet(hold.payerId, hold.amountKobo, "ESCROW_REFUND", { bookingId: hold.bookingId, reference, description }, tx);

    return tx.escrowHold.update({ where: { id: holdId }, data: { status: "REFUNDED", refundedAt: new Date() } });
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
    await releaseHold(hold.id, { description: "Auto-released after the escrow window elapsed." });
  }
  return due.length;
}

module.exports = {
  createHold,
  createHoldsForBooking,
  releaseHold,
  releaseAllHoldsForBooking,
  refundHold,
  refundAllHoldsForBooking,
  runAutoReleaseSweep,
};
