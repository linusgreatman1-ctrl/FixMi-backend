const prisma = require("../config/db");

// All balance mutations go through here so every change is paired with a
// Transaction row — the wallet screens (earnings, "Total Earned / Pending /
// Withdrawn") are just aggregates over Transaction, never a separately
// maintained running total that could drift.

async function getOrCreateWallet(userId, tx = prisma) {
  const existing = await tx.wallet.findUnique({ where: { userId } });
  if (existing) return existing;
  return tx.wallet.create({ data: { userId } });
}

async function creditWallet(userId, amountKobo, type, { bookingId, reference, description } = {}, tx = prisma) {
  if (amountKobo <= 0) throw Object.assign(new Error("Credit amount must be positive."), { status: 400 });
  const wallet = await getOrCreateWallet(userId, tx);
  const updated = await tx.wallet.update({ where: { id: wallet.id }, data: { balanceKobo: { increment: amountKobo } } });
  await tx.transaction.create({
    data: { walletId: wallet.id, type, amountKobo, balanceAfterKobo: updated.balanceKobo, bookingId, reference, description },
  });
  return updated;
}

// DEV_BYPASS_PAYMENTS=true only switches on the testing shortcuts for ADDING money
// (an instant dev top-up, and a payer confirming their own bank transfer).
// It never lets money be spent that isn't there: a wallet can't go below zero,
// so a request that hasn't been paid for into escrow can't go through.
function devBypassEnabled() {
  return process.env.DEV_BYPASS_PAYMENTS === "true";
}

async function debitWallet(userId, amountKobo, type, { bookingId, reference, description } = {}, tx = prisma) {
  if (amountKobo <= 0) throw Object.assign(new Error("Debit amount must be positive."), { status: 400 });
  const wallet = await getOrCreateWallet(userId, tx);
  if (wallet.balanceKobo < amountKobo) {
    throw Object.assign(new Error("Insufficient wallet balance."), { status: 400, shortfallKobo: amountKobo - wallet.balanceKobo });
  }
  const updated = await tx.wallet.update({ where: { id: wallet.id }, data: { balanceKobo: { decrement: amountKobo } } });
  await tx.transaction.create({
    data: { walletId: wallet.id, type, amountKobo: -amountKobo, balanceAfterKobo: updated.balanceKobo, bookingId, reference, description },
  });
  return updated;
}

module.exports = { getOrCreateWallet, creditWallet, debitWallet, devBypassEnabled };
