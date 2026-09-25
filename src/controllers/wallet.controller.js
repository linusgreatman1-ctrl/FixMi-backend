const prisma = require("../config/db");
const wallet = require("../services/wallet.service");
const { generateReference } = require("../utils/reference");

async function getWallet(req, res, next) {
  try {
    const w = await wallet.getOrCreateWallet(req.user.id);
    res.json({ wallet: w });
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
    const account = await prisma.user.findUnique({ where: { id: req.user.id }, select: { bankAccountNumber: true } });
    if (!account?.bankAccountNumber) {
      return res.status(400).json({ error: "Link a bank account before withdrawing." });
    }

    const w = await wallet.getOrCreateWallet(req.user.id);
    const reference = generateReference("WD");

    const result = await prisma.$transaction(async (tx) => {
      await wallet.debitWallet(req.user.id, Number(amountKobo), "WITHDRAWAL", { reference, description: "Wallet withdrawal" }, tx);
      return tx.withdrawal.create({
        data: { userId: req.user.id, walletId: w.id, amountKobo: Number(amountKobo), status: "PENDING", paystackRef: reference },
      });
    });

    // A real payout would call paystack.service's transfer here. Left as
    // PENDING for an admin/cron to action via Paystack's Transfer API —
    // see README "Known simplifications".
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

module.exports = { getWallet, listTransactions, withdraw, listWithdrawals };
