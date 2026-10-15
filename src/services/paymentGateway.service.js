// The one place for card/USSD payments, with two gateways underneath: Paystack
// and Flutterwave (same design as Handa). Every checkout is recorded as a
// PaymentIntent (gateway, amount due, what it is for) before the customer
// pays. Checking a payment goes back to the gateway it was paid on, and it
// only counts if that gateway says it succeeded, in NGN, for at least the
// amount due. What it pays for comes from our record, never the gateway's reply.
const prisma = require("../config/db");
const paystack = require("./paystack.service");
const flutterwave = require("./flutterwave.service");

const GATEWAYS = ["paystack", "flutterwave"];

function available() {
  return { paystack: !!process.env.PAYSTACK_SECRET_KEY, flutterwave: flutterwave.isConfigured() };
}

function anyConfigured() {
  const a = available();
  return a.paystack || a.flutterwave;
}

// The customer's choice if that gateway is set up, otherwise whichever is.
function pick(requested) {
  const a = available();
  const want = String(requested || "").toLowerCase();
  if (GATEWAYS.includes(want) && a[want]) return want;
  if (a.paystack) return "paystack";
  if (a.flutterwave) return "flutterwave";
  throw Object.assign(new Error("Card payments aren't available yet."), { status: 503 });
}

async function initializeTransaction({ email, amountKobo, reference, metadata, gateway, channel, callbackUrl }) {
  const gw = pick(gateway);
  await prisma.paymentIntent.upsert({
    where: { reference },
    create: { reference, gateway: gw, amountKobo, metadata: metadata || {}, email: email || null },
    update: { gateway: gw, amountKobo, metadata: metadata || {}, email: email || null },
  });
  const impl = gw === "flutterwave" ? flutterwave : paystack;
  const data = await impl.initializeTransaction({ email, amountKobo, reference, metadata, channel: channel === "ussd" ? "ussd" : "card", channels: channel === "ussd" ? ["ussd"] : ["card", "bank", "bank_transfer"], callbackUrl });
  return { ...data, gateway: gw };
}

// -> { status, reference, amount (kobo), metadata, gateway }; null when we never started this checkout.
async function verifyTransaction(reference) {
  const intent = await prisma.paymentIntent.findUnique({ where: { reference } });
  if (!intent) return null;
  let status, paidKobo, currency;
  if (intent.gateway === "flutterwave") {
    const d = await flutterwave.verifyTransaction(reference);
    status = d.status; paidKobo = d.amountKobo; currency = d.currency;
  } else {
    const d = await paystack.verifyTransaction(reference);
    status = d.status; paidKobo = Number(d.amount || 0); currency = d.currency || "NGN";
  }
  const ok = status === "success" && currency === "NGN" && paidKobo >= intent.amountKobo;
  return { status: ok ? "success" : status === "success" ? "amount_mismatch" : status, reference, amount: intent.amountKobo, metadata: intent.metadata, gateway: intent.gateway };
}

// Marks a reference as applied; false if it already was, so a payment is
// credited exactly once however many times it gets checked.
async function claimApplication(reference) {
  const r = await prisma.paymentIntent.updateMany({ where: { reference, appliedAt: null }, data: { appliedAt: new Date() } });
  return r.count === 1;
}
async function releaseApplication(reference) {
  await prisma.paymentIntent.updateMany({ where: { reference }, data: { appliedAt: null } });
}

module.exports = { available, anyConfigured, pick, initializeTransaction, verifyTransaction, claimApplication, releaseApplication };
