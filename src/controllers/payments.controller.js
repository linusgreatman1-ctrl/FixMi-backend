const crypto = require("crypto");
const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const wallet = require("../services/wallet.service");
const pay = require("../services/paymentApply.service");
const { generateReference } = require("../utils/reference");

// Which payment methods the app can offer right now (wallet balance included).
async function methods(req, res, next) {
  try {
    res.json(await pay.methodsFor(req.user.id));
  } catch (err) {
    next(err);
  }
}

// Starts a card, USSD or bank-transfer payment for a wallet top-up, or for a
// booking that is waiting for its escrow payment.
async function checkout(req, res, next) {
  try {
    const { purpose, bookingId } = req.body;
    const method = String(req.body.method || "").toUpperCase();
    if (purpose === "WALLET_DEPOSIT") {
      const amountKobo = Math.round(Number(req.body.amountKobo));
      return res.json(await pay.startCheckout({ user: req.user, purpose, method, amountKobo, req }));
    }
    if (purpose === "BOOKING_PAYMENT") {
      const booking = await prisma.booking.findUnique({ where: { id: String(bookingId || "") } });
      if (!booking || booking.customerId !== req.user.id) return res.status(404).json({ error: "Booking not found." });
      if (booking.status !== "PENDING_PAYMENT") return res.status(409).json({ error: "This booking doesn't need a payment." });
      if (method === "WALLET") {
        const { fundPendingBooking } = require("./bookings.controller");
        await fundPendingBooking(req.app.get("io"), booking.id);
        return res.json({ paid: true });
      }
      return res.json(await pay.startCheckout({ user: req.user, purpose, method, amountKobo: booking.priceKobo, targetId: booking.id, req }));
    }
    res.status(400).json({ error: "Unknown payment." });
  } catch (err) {
    next(err);
  }
}

// Older clients: wallet top-up by card.
async function initializeWalletDeposit(req, res, next) {
  req.body = { purpose: "WALLET_DEPOSIT", method: "CARD", amountKobo: req.body.amountKobo };
  return checkout(req, res, next);
}

// Dev/demo shortcut: credits the wallet directly without a real charge.
// Only while DEV_BYPASS_PAYMENTS is on.
async function devTopUp(req, res, next) {
  try {
    if (!wallet.devBypassEnabled()) return res.status(403).json({ error: "Dev bypass is not enabled." });
    const { amountKobo } = req.body;
    if (!amountKobo || Number(amountKobo) <= 0) return res.status(400).json({ error: "A positive amountKobo is required." });
    const w = await wallet.creditWallet(req.user.id, Number(amountKobo), "DEPOSIT", { reference: generateReference("DEVDEP"), description: "Dev top-up (no real payment)" });
    res.json({ wallet: w });
  } catch (err) {
    next(err);
  }
}

// Payer-side status of a bank-transfer request (polled by the app).
async function getManual(req, res, next) {
  try {
    const request = await prisma.manualPaymentRequest.findUnique({ where: { id: req.params.id } });
    if (!request || request.userId !== req.user.id) return res.status(404).json({ error: "Request not found." });
    res.json({ request });
  } catch (err) {
    next(err);
  }
}

// Testing only: lets the payer confirm their own transfer when DEV_BYPASS_PAYMENTS is on.
// In production a transfer stays PENDING until an admin confirms it.
async function devConfirmManual(req, res, next) {
  try {
    if (!wallet.devBypassEnabled()) return res.status(403).json({ error: "Dev bypass is not enabled." });
    const request = await prisma.manualPaymentRequest.findUnique({ where: { id: req.params.id } });
    if (!request || request.userId !== req.user.id) return res.status(404).json({ error: "Request not found." });
    res.json({ request: await confirmManualRequest(request.id, null, req.app.get("io")) });
  } catch (err) {
    next(err);
  }
}

// Marks a pending transfer confirmed and applies it, exactly once. If applying fails
// the request goes back to pending so it can be retried.
async function confirmManualRequest(id, adminId, io) {
  const claimed = await prisma.manualPaymentRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "CONFIRMED", processedById: adminId, processedAt: new Date() } });
  if (!claimed.count) throw Object.assign(new Error("This transfer is already processed or does not exist."), { status: 409 });
  const row = await prisma.manualPaymentRequest.findUnique({ where: { id } });
  try {
    await pay.applyPayment({ purpose: row.purpose, userId: row.userId, amountKobo: row.amountKobo, reference: row.reference, targetId: row.targetId }, io);
  } catch (err) {
    await prisma.manualPaymentRequest.update({ where: { id }, data: { status: "PENDING", processedById: null, processedAt: null } });
    throw err;
  }
  return row;
}

// Applies a verified Paystack payment once, however many times it is reported.
async function applyOnce(data, io) {
  const meta = data.metadata || {};
  const reference = data.reference;
  const already = await prisma.paymentWebhookEvent.findUnique({ where: { eventRef: reference } });
  if (already) return { duplicate: true, purpose: meta.purpose, bookingId: meta.bookingId };
  await prisma.paymentWebhookEvent.create({ data: { eventRef: reference, payload: data } });
  try {
    const r = await pay.applyPayment({ purpose: meta.purpose, userId: meta.userId, amountKobo: data.amount, reference, targetId: meta.bookingId || meta.plan }, io);
    return r;
  } catch (err) {
    await prisma.paymentWebhookEvent.delete({ where: { eventRef: reference } }).catch(() => {}); // let a retry apply it
    throw err;
  }
}

// Called by the app when the customer returns from the card page, and by the
// webhook: both are safe to repeat.
async function verifyPayment(req, res, next) {
  try {
    const data = await paystack.verifyTransaction(req.params.reference);
    const meta = data.metadata || {};
    if (data.status !== "success") {
      return res.status(402).json({ error: "Payment was not successful.", status: data.status, purpose: meta.purpose, bookingId: meta.bookingId });
    }
    if (meta.userId && meta.userId !== req.user.id) return res.status(403).json({ error: "This payment belongs to another account." });
    const result = await applyOnce(data, req.app.get("io"));
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

// A bank / payment-provider feed tells FixMi that money arrived in the company account (see services/bankCredit.service.js):
// POST /api/payments/webhook/bank-credit?provider=flutterwave|paystack|monnify|generic
async function bankCreditWebhook(req, res, next) {
  try {
    const bank = require("../services/bankCredit.service");
    const provider = String(req.query.provider || "generic");
    if (!bank.verifySignature(provider, req)) return res.status(401).json({ error: "Invalid signature." });
    const credit = bank.normalize(provider, req.body);
    if (!credit) return res.status(200).json({ received: true, ignored: true });
    res.status(200).json({ received: true, ...(await bank.processCredit(credit, req.app.get("io"))) });
  } catch (err) {
    next(err);
  }
}

// Paystack signs webhook bodies with HMAC-SHA512 of the raw body using the
// secret key; checking it stops anyone posting a fake "payment succeeded".
async function webhook(req, res, next) {
  try {
    const signature = req.headers["x-paystack-signature"];
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const expected = crypto.createHmac("sha512", secret || "").update(req.rawBody || "").digest("hex");
    if (!secret || signature !== expected) return res.status(401).json({ error: "Invalid webhook signature." });

    const event = req.body;
    if (event.event === "charge.success") {
      await applyOnce(event.data, req.app.get("io"));
    } else if (event.event === "transfer.success" || event.event === "transfer.failed") {
      const status = event.event === "transfer.success" ? "PAID" : "FAILED";
      await prisma.withdrawal.updateMany({ where: { paystackRef: event.data.reference }, data: { status, processedAt: new Date() } });
    }
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { bankCreditWebhook, methods, checkout, initializeWalletDeposit, devTopUp, getManual, devConfirmManual, confirmManualRequest, verifyPayment, webhook };
