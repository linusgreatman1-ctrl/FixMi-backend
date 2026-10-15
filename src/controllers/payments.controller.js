const crypto = require("crypto");
const prisma = require("../config/db");
const wallet = require("../services/wallet.service");
const gateway = require("../services/paymentGateway.service");
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
    const gatewayName = req.body.gateway;
    if (purpose === "WALLET_DEPOSIT") {
      const amountKobo = Math.round(Number(req.body.amountKobo));
      return res.json(await pay.startCheckout({ user: req.user, purpose, method, amountKobo, gatewayName, req }));
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
      return res.json(await pay.startCheckout({ user: req.user, purpose, method, amountKobo: booking.priceKobo, targetId: booking.id, gatewayName, req }));
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

// Dev/demo shortcut: credits the wallet directly without a real charge. Only while DEV_BYPASS_PAYMENTS is on.
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

// Payer-side status of a bank-transfer / practice-checkout request (polled by the app).
async function getManual(req, res, next) {
  try {
    const request = await prisma.manualPaymentRequest.findUnique({ where: { id: req.params.id } });
    if (!request || request.userId !== req.user.id) return res.status(404).json({ error: "Request not found." });
    res.json({ request });
  } catch (err) {
    next(err);
  }
}

// Testing only: lets the payer finish their own transfer or practice checkout while
// DEV_BYPASS_PAYMENTS is on. In production a transfer stays PENDING until an admin confirms it.
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
  if (!claimed.count) throw Object.assign(new Error("This payment is already processed or does not exist."), { status: 409 });
  const row = await prisma.manualPaymentRequest.findUnique({ where: { id } });
  try {
    await pay.applyPayment({ purpose: row.purpose, userId: row.userId, amountKobo: row.amountKobo, reference: row.reference, targetId: row.targetId }, io);
  } catch (err) {
    await prisma.manualPaymentRequest.update({ where: { id }, data: { status: "PENDING", processedById: null, processedAt: null } });
    throw err;
  }
  return row;
}

// Checks a card/USSD payment with the gateway it was paid on and, if it really
// succeeded, applies it exactly once however many times it is checked (the app
// polling, the return page, either webhook).
async function confirmAndApply(reference, io) {
  const d = await gateway.verifyTransaction(reference);
  if (!d) return { paid: false, status: "unknown" };
  const meta = d.metadata || {};
  if (d.status !== "success") return { paid: false, status: d.status, purpose: meta.purpose, bookingId: meta.bookingId };
  if (!(await gateway.claimApplication(reference))) return { paid: true, duplicate: true, purpose: meta.purpose, bookingId: meta.bookingId };
  try {
    const r = await pay.applyPayment({ purpose: meta.purpose, userId: meta.userId, amountKobo: d.amount, reference, targetId: meta.bookingId || meta.plan }, io);
    return { paid: true, ...r };
  } catch (err) {
    await gateway.releaseApplication(reference); // let a retry apply it
    throw err;
  }
}

async function verifyPayment(req, res, next) {
  try {
    const intent = await prisma.paymentIntent.findUnique({ where: { reference: req.params.reference } });
    if (!intent) return res.status(404).json({ error: "Payment not found." });
    if (intent.metadata && intent.metadata.userId && intent.metadata.userId !== req.user.id) return res.status(403).json({ error: "This payment belongs to another account." });
    const r = await confirmAndApply(req.params.reference, req.app.get("io"));
    if (!r.paid) return res.status(402).json({ error: "Payment was not successful.", status: r.status, purpose: r.purpose, bookingId: r.bookingId });
    res.json({ success: true, ...r });
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

// Paystack signs webhook bodies with HMAC-SHA512 of the raw body using the secret
// key; checking it stops anyone posting a fake "payment succeeded". We still check
// the payment with Paystack before applying it.
async function webhook(req, res, next) {
  try {
    const signature = req.headers["x-paystack-signature"];
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const expected = crypto.createHmac("sha512", secret || "").update(req.rawBody || "").digest("hex");
    if (!secret || signature !== expected) return res.status(401).json({ error: "Invalid webhook signature." });

    const event = req.body;
    if (event.event === "charge.success") {
      await confirmAndApply(event.data.reference, req.app.get("io"));
    } else if (event.event === "transfer.success" || event.event === "transfer.failed") {
      const status = event.event === "transfer.success" ? "PAID" : "FAILED";
      await prisma.withdrawal.updateMany({ where: { paystackRef: event.data.reference }, data: { status, processedAt: new Date() } });
    }
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}

// Flutterwave sends the secret hash you set (FLW_SECRET_HASH) in the verif-hash header.
async function flutterwaveWebhook(req, res, next) {
  try {
    const secretHash = process.env.FLW_SECRET_HASH;
    if (!secretHash || req.headers["verif-hash"] !== secretHash) return res.status(401).json({ error: "Invalid webhook signature." });
    const data = req.body && req.body.data;
    if (data && data.tx_ref) await confirmAndApply(data.tx_ref, req.app.get("io"));
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { bankCreditWebhook, methods, checkout, initializeWalletDeposit, devTopUp, getManual, devConfirmManual, confirmManualRequest, verifyPayment, webhook, flutterwaveWebhook };
