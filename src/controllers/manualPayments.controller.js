const prisma = require("../config/db");
const settings = require("../services/settings.service");
const { notifyAllAdmins } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");

const MIN_KOBO = 100000; // ₦1,000
const MAX_KOBO = 500000000; // ₦5,000,000

// The company account the user transfers to, plus the reference to quote.
async function info(req, res, next) {
  try {
    res.json({ bank: await settings.get("bank.company"), minKobo: MIN_KOBO });
  } catch (err) {
    next(err);
  }
}

// "I have transferred": records the request; an admin confirms it against the bank statement.
async function create(req, res, next) {
  try {
    const amountKobo = Math.round(Number(req.body.amountKobo));
    if (!Number.isFinite(amountKobo) || amountKobo < MIN_KOBO) return res.status(400).json({ error: "The minimum bank transfer is ₦1,000." });
    if (amountKobo > MAX_KOBO) return res.status(400).json({ error: "That amount is too large. Contact support." });
    const bank = await settings.get("bank.company");
    if (!bank || !bank.accountNumber) return res.status(503).json({ error: "Bank transfer is not set up yet. Please try again later." });
    const pending = await prisma.manualPaymentRequest.count({ where: { userId: req.user.id, status: "PENDING" } });
    if (pending >= 3) return res.status(429).json({ error: "You already have transfers waiting to be confirmed." });

    const payment = await prisma.manualPaymentRequest.create({
      data: {
        userId: req.user.id,
        amountKobo,
        reference: generateReference("BT"),
        senderName: req.body.senderName ? String(req.body.senderName).trim().slice(0, 80) : null,
        note: req.body.note ? String(req.body.note).trim().slice(0, 300) : null,
      },
    });
    notifyAllAdmins(req.app.get("io"), "🏦 Bank transfer to confirm", `${req.user.name} says they sent ₦${Math.round(amountKobo / 100).toLocaleString("en-NG")} (ref ${payment.reference})`, { manualPaymentId: payment.id }).catch(() => {});
    res.status(201).json({ payment, bank });
  } catch (err) {
    next(err);
  }
}

async function listMine(req, res, next) {
  try {
    res.json({ payments: await prisma.manualPaymentRequest.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: 30 }) });
  } catch (err) {
    next(err);
  }
}

module.exports = { info, create, listMine };
