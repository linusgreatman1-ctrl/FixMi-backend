const prisma = require("../config/db");
const wallet = require("../services/wallet.service");
const { generateReference } = require("../utils/reference");
const { notifyAllAdmins } = require("../services/notifications.service");

async function getWallet(req, res, next) {
  try {
    const w = await wallet.getOrCreateWallet(req.user.id);
    res.json({ wallet: w });
  } catch (err) {
    next(err);
  }
}

// The profile "Wallet" card: balance, what is held in escrow for jobs you paid
// for, what has been released, what is frozen in a dispute, and the live orders.
async function summary(req, res, next) {
  try {
    const w = await wallet.getOrCreateWallet(req.user.id);
    const holds = await prisma.escrowHold.findMany({
      where: { payerId: req.user.id },
      select: { amountKobo: true, status: true, bookingId: true, booking: { select: { id: true, category: true, status: true, artisan: { select: { user: { select: { name: true } } } } } } },
    });
    const total = (status) => holds.filter((h) => h.status === status).reduce((n, h) => n + h.amountKobo, 0);
    const active = {};
    for (const h of holds.filter((x) => x.status === "HELD" || x.status === "DISPUTED")) {
      const a = (active[h.bookingId] = active[h.bookingId] || { bookingId: h.bookingId, category: h.booking.category, status: h.booking.status, artisanName: h.booking.artisan?.user?.name || null, amountKobo: 0, disputed: false });
      a.amountKobo += h.amountKobo;
      if (h.status === "DISPUTED") a.disputed = true;
    }
    res.json({
      balanceKobo: w.balanceKobo,
      inEscrowKobo: total("HELD"),
      releasedKobo: total("RELEASED"),
      disputedKobo: total("DISPUTED"),
      activeOrders: Object.values(active),
    });
  } catch (err) {
    next(err);
  }
}

async function listTransactions(req, res, next) {
  try {
    const w = await wallet.getOrCreateWallet(req.user.id);
    const transactions = await prisma.transaction.findMany({ where: { walletId: w.id }, orderBy: { createdAt: "desc" }, take: 100 });
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
}

async function withdraw(req, res, next) {
  try {
    const { amountKobo } = req.body;
    if (!amountKobo || Number(amountKobo) <= 0) return res.status(400).json({ error: "A positive amountKobo is required." });
    const account = await prisma.user.findUnique({ where: { id: req.user.id }, select: { bankAccountNumber: true, bankName: true, bankAccountName: true } });
    if (!account?.bankAccountNumber) {
      return res.status(400).json({ error: "Link a bank account before withdrawing." });
    }

    const w = await wallet.getOrCreateWallet(req.user.id);
    const reference = generateReference("WD");

    const result = await prisma.$transaction(async (tx) => {
      await wallet.debitWallet(req.user.id, Number(amountKobo), "WITHDRAWAL", { reference, description: "Wallet withdrawal" }, tx);
      return tx.withdrawal.create({
        data: { userId: req.user.id, walletId: w.id, amountKobo: Number(amountKobo), status: "PENDING", paystackRef: reference, bankName: account.bankName, accountNumber: account.bankAccountNumber, accountName: account.bankAccountName },
      });
    });

    // A real payout would call paystack.service's transfer here. Left as
    // PENDING for an admin/cron to action via Paystack's Transfer API —
    // see README "Known simplifications".
    notifyAllAdmins(req.app.get("io"), "💸 Withdrawal requested", `${req.user.name} asked to withdraw ₦${Math.round(Number(amountKobo) / 100).toLocaleString("en-NG")}.`, { withdrawalId: result.id, userId: req.user.id, kind: "WITHDRAWAL" }).catch(() => {});
    res.status(201).json({ withdrawal: result });
  } catch (err) {
    next(err);
  }
}

async function listWithdrawals(req, res, next) {
  try {
    const withdrawals = await prisma.withdrawal.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
    res.json({ withdrawals });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  summary, getWallet, listTransactions, withdraw, listWithdrawals };
