const crypto = require("crypto");
const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const wallet = require("../services/wallet.service");
const { generateReference } = require("../utils/reference");

// Wallet top-up ("Top Up" screen). Booking payments always debit the
// wallet balance directly (bookings.controller.payBooking) — Paystack is
// only ever the on-ramp into that balance, never a per-booking charge.
async function initializeWalletDeposit(req, res, next) {
  try {
    const { amountKobo } = req.body;
    if (!amountKobo || amountKobo < 10000) return res.status(400).json({ error: "Minimum top-up is ₦100." });
    if (!req.user.email) return res.status(400).json({ error: "Add an email to your profile before funding your wallet." });

    const reference = generateReference("DEP");
    const data = await paystack.initializeTransaction({
      email: req.user.email,
      amountKobo,
      reference,
      metadata: { purpose: "WALLET_DEPOSIT", userId: req.user.id },
    });
    res.json({ authorizationUrl: data.authorization_url, reference });
  } catch (err) {
    next(err);
  }
}

// Dev/demo shortcut: credits the wallet directly without a real Paystack
// charge, gated the same way DEV_BYPASS_PAYMENTS gates the wallet-debit
// check — never available once that flag is off.
async function devTopUp(req, res, next) {
  try {
    if (!wallet.devBypassEnabled()) return res.status(403).json({ error: "Dev bypass is not enabled." });
    const { amountKobo } = req.body;
    if (!amountKobo || Number(amountKobo) <= 0) return res.status(400).json({ error: "A positive amountKobo is required." });
    const reference = generateReference("DEVDEP");
    const w = await wallet.creditWallet(req.user.id, Number(amountKobo), "DEPOSIT", { reference, description: "Dev top-up (no real payment)" });
    res.json({ wallet: w });
  } catch (err) {
    next(err);
  }
}

async function applyVerifiedPayment(data) {
  const purpose = data.metadata?.purpose;
  if (purpose === "WALLET_DEPOSIT") {
    await wallet.creditWallet(data.metadata.userId, data.amount, "DEPOSIT", { reference: data.reference, description: "Wallet top-up via Paystack" });
    return { purpose };
  }
  return { purpose: purpose || "UNKNOWN" };
}

// Called by the frontend after Paystack's inline checkout closes, and
// independently by the webhook — both idempotent via PaymentWebhookEvent /
// this same reference only ever crediting once.
async function verifyPayment(req, res, next) {
  try {
    const { reference } = req.params;
    const data = await paystack.verifyTransaction(reference);
    if (data.status !== "success") {
      return res.status(402).json({ error: "Payment was not successful.", status: data.status });
    }
    const already = await prisma.paymentWebhookEvent.findUnique({ where: { eventRef: reference } });
    if (already) return res.json({ success: true, duplicate: true });
    await prisma.paymentWebhookEvent.create({ data: { eventRef: reference, payload: data } });
    const result = await applyVerifiedPayment(data);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

// Paystack signs webhook bodies with HMAC-SHA512 of the raw request body
// using the secret key — verifying this is what stops anyone from POSTing
// a fake "payment succeeded" event straight at this endpoint.
async function webhook(req, res, next) {
  try {
    const signature = req.headers["x-paystack-signature"];
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const expected = crypto.createHmac("sha512", secret || "").update(req.rawBody || "").digest("hex");
    if (!secret || signature !== expected) {
      return res.status(401).json({ error: "Invalid webhook signature." });
    }

    const event = req.body;
    const eventRef = event?.data?.reference || event?.id?.toString();
    if (!eventRef) return res.status(400).json({ error: "Missing event reference." });

    const already = await prisma.paymentWebhookEvent.findUnique({ where: { eventRef } });
    if (already) return res.json({ received: true, duplicate: true });
    await prisma.paymentWebhookEvent.create({ data: { eventRef, payload: event } });

    if (event.event === "charge.success") {
      await applyVerifiedPayment(event.data);
    } else if (event.event === "transfer.success" || event.event === "transfer.failed") {
      const status = event.event === "transfer.success" ? "PAID" : "FAILED";
      await prisma.withdrawal.updateMany({ where: { paystackRef: event.data.reference }, data: { status, processedAt: new Date() } });
    }

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { initializeWalletDeposit, devTopUp, verifyPayment, webhook };
