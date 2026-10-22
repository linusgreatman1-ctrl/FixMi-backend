const prisma = require("../config/db");
const wallet = require("./wallet.service");
const gateway = require("./paymentGateway.service");
const settings = require("./settings.service");
const { notifyAllAdmins } = require("./notifications.service");
const { generateReference } = require("../utils/reference");

// One place that knows how every kind of payment is collected and what it pays
// for, like Handa's escrow payment: the same four methods (wallet, card, USSD,
// bank transfer) for a booking's escrow, a featured boost or a wallet top-up.
// Money from a card or a confirmed bank transfer is first credited to the
// wallet, then spent on whatever it was for.
//
// Test mode (DEV_BYPASS_PAYMENTS=true): every method works even with no
// payment keys or bank details set up, so the whole flow can be tried. Card
// and USSD show a practice checkout and bank transfer a practice account;
// nothing real is charged.

const PURPOSES = ["WALLET_DEPOSIT", "BOOKING_PAYMENT", "FEATURE_BOOST_PAYMENT", "CORPORATE_PLAN", "CORPORATE_TOPUP"];
const PREFIX = { WALLET_DEPOSIT: "DEP", BOOKING_PAYMENT: "ESC", FEATURE_BOOST_PAYMENT: "BST", CORPORATE_PLAN: "CRP", CORPORATE_TOPUP: "CRT" };
const TEST_BANK = { bankName: "Test Bank (testing only)", accountNumber: "0000000000", accountName: "FixMi test account" };

const naira = (k) => `₦${Math.round((k || 0) / 100).toLocaleString("en-NG")}`;
const fail = (status, message) => Object.assign(new Error(message), { status });
const testMode = () => wallet.devBypassEnabled();

async function companyBank() {
  const bank = await settings.get("bank.company");
  if (bank && bank.accountNumber) return bank;
  return testMode() ? TEST_BANK : null;
}

// What the payment screen can offer right now.
async function methodsFor(userId) {
  const [w, bank] = await Promise.all([wallet.getOrCreateWallet(userId), companyBank()]);
  const live = gateway.anyConfigured();
  return {
    wallet: true,
    card: live || testMode(),
    ussd: live || testMode(),
    bankTransfer: !!bank,
    gateways: gateway.available(),
    balanceKobo: w.balanceKobo,
    devBypass: testMode(),
    testMode: testMode() && !live,
  };
}

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const proto = (req && (req.headers["x-forwarded-proto"] || req.protocol)) || "https";
  const host = req && (req.headers["x-forwarded-host"] || req.headers.host);
  return host ? `${String(proto).split(",")[0]}://${host}` : "";
}

// Starts a card/USSD checkout or a bank-transfer request. Returns what the app needs next:
//   { authorizationUrl, reference, gateway }                 card/USSD page to show
//   { manual: true, requestId, reference, bank }             bank transfer details
//   { testCheckout: true, channel, requestId, reference }    practice checkout (test mode)
async function startCheckout({ user, purpose, method, amountKobo, targetId, gatewayName, req }) {
  if (!PURPOSES.includes(purpose)) throw fail(400, "Unknown payment.");
  if (!Number.isFinite(amountKobo) || amountKobo < 10000) throw fail(400, "Minimum payment is ₦100.");
  const reference = generateReference(PREFIX[purpose]);

  if (method === "BANK_TRANSFER") {
    const bank = await companyBank();
    if (!bank) throw fail(503, "Bank transfer isn't set up yet. Please use another method or try again later.");
    const request = await prisma.manualPaymentRequest.create({
      data: { userId: user.id, amountKobo, reference, purpose, targetId: targetId ? String(targetId) : null, channel: "BANK_TRANSFER" },
    });
    notifyAllAdmins(req?.app?.get("io"), "🏦 Bank transfer started", `${user.name} is paying ${naira(amountKobo)} by bank transfer (ref ${reference}). Confirm it once the money lands.`, { manualPaymentId: request.id }).catch(() => {});
    return { manual: true, requestId: request.id, reference, amountKobo, bank };
  }

  if (!["CARD", "USSD"].includes(method)) throw fail(400, "Choose a payment method.");

  if (gateway.anyConfigured()) {
    const email = user.email || `${String(user.phone || user.id).replace(/\W/g, "")}@pay.fixmi.app`;
    const metadata = { purpose, userId: user.id };
    if (purpose === "BOOKING_PAYMENT") metadata.bookingId = targetId;
    if (purpose === "FEATURE_BOOST_PAYMENT" || purpose === "CORPORATE_PLAN") metadata.plan = targetId;
    const data = await gateway.initializeTransaction({
      gateway: gatewayName, email, amountKobo, reference, metadata, channel: method === "USSD" ? "ussd" : "card",
      callbackUrl: `${baseUrl(req)}/pay-done.html?ref=${encodeURIComponent(reference)}`,
    });
    return { authorizationUrl: data.authorization_url, reference, amountKobo, gateway: data.gateway };
  }

  if (testMode()) {
    const request = await prisma.manualPaymentRequest.create({
      data: { userId: user.id, amountKobo, reference, purpose, targetId: targetId ? String(targetId) : null, channel: method },
    });
    return { testCheckout: true, channel: method, requestId: request.id, reference, amountKobo };
  }
  throw fail(503, "Card payments aren't available yet. Please use your wallet or a bank transfer.");
}

// Buys a featured boost: takes the price from the wallet, records it and
// extends the artisan's featured period (from the current end if still featured).
async function purchaseBoost(userId, planKey, { reference } = {}) {
  const plans = await settings.get("promotion.plans");
  const plan = plans[planKey];
  if (!plan) throw fail(400, "Choose a promotion plan.");
  const profile = await prisma.artisanProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) throw fail(403, "No artisan profile found.");
  const ref = reference || generateReference("BST");
  return prisma.$transaction(async (tx) => {
    await wallet.debitWallet(userId, plan.priceKobo, "ADJUSTMENT", { reference: ref, description: `Promotion: ${plan.label} (${plan.days} days)` }, tx);
    const current = await tx.artisanProfile.findUnique({ where: { id: profile.id }, select: { featuredUntil: true } });
    const start = current.featuredUntil && current.featuredUntil > new Date() ? current.featuredUntil : new Date();
    const endsAt = new Date(start.getTime() + plan.days * 86400000);
    await tx.featureBoost.create({ data: { userId, artisanId: profile.id, plan: planKey, days: plan.days, amountKobo: plan.priceKobo, startsAt: start, endsAt } });
    const updated = await tx.artisanProfile.update({ where: { id: profile.id }, data: { featuredUntil: endsAt } });
    return { artisanProfile: updated, plan: plan.label };
  });
}

// A payment has really arrived (the gateway confirmed it, or an admin confirmed the transfer):
// credit the wallet, then do what it was for.
async function applyPayment({ purpose, userId, amountKobo, reference, targetId }, io) {
  await wallet.creditWallet(userId, amountKobo, "DEPOSIT", { reference, description: purpose === "WALLET_DEPOSIT" ? "Wallet top-up" : "Payment received" });
  if (purpose === "BOOKING_PAYMENT") {
    const { fundPendingBooking } = require("../controllers/bookings.controller");
    const r = await fundPendingBooking(io, targetId);
    return { purpose, bookingId: targetId, activated: !!r };
  }
  if (purpose === "FEATURE_BOOST_PAYMENT") {
    await purchaseBoost(userId, targetId, { reference });
    return { purpose, plan: targetId };
  }
  if (purpose === "CORPORATE_PLAN") {
    const corp = require("../controllers/corporate.controller");
    let choice = {};
    try { choice = JSON.parse(targetId || "{}"); } catch (e) { /* handled below */ }
    await corp.subscribeFromWallet(userId, String(choice.plan || ""), Array.isArray(choice.categories) ? choice.categories : [], io);
    return { purpose, plan: choice.plan };
  }
  if (purpose === "CORPORATE_TOPUP") {
    const corp = require("../controllers/corporate.controller");
    await corp.topUpFromWallet(userId, amountKobo, io);
    return { purpose };
  }
  return { purpose };
}

module.exports = { PURPOSES, methodsFor, companyBank, startCheckout, purchaseBoost, applyPayment };
