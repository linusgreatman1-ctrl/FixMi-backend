const prisma = require("../config/db");
const paystack = require("../services/paystack.service");
const wallet = require("../services/wallet.service");
const { generateReference } = require("../utils/reference");
const settings = require("../services/settings.service");

function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

async function updateMe(req, res, next) {
  try {
    const { name, address, state, lga } = req.body;
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        name: name ?? undefined,
        address: address ?? undefined,
        state: state ?? undefined,
        lga: lga ?? undefined,
      },
      include: { artisanProfile: true, wallet: true },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

async function updateArtisanProfile(req, res, next) {
  try {
    if (!req.user.artisanProfile) return res.status(403).json({ error: "No artisan profile found." });
    const { category, bizName, bio, yearsExp, lat, lng } = req.body;
    const profile = await prisma.artisanProfile.update({
      where: { id: req.user.artisanProfile.id },
      data: {
        category: category ?? undefined,
        bizName: bizName ?? undefined,
        bio: bio ?? undefined,
        yearsExp: yearsExp !== undefined ? Number(yearsExp) : undefined,
        lat: lat !== undefined ? Number(lat) : undefined,
        lng: lng !== undefined ? Number(lng) : undefined,
      },
    });
    res.json({ artisanProfile: profile });
  } catch (err) {
    next(err);
  }
}

// Matches the frontend's availability toggle — an artisan must be online to
// show up in nearby search / receive new job dispatch.
async function setAvailability(req, res, next) {
  try {
    if (!req.user.artisanProfile) return res.status(403).json({ error: "No artisan profile found." });
    const { isAvailable } = req.body;
    const profile = await prisma.artisanProfile.update({
      where: { id: req.user.artisanProfile.id },
      data: { isAvailable: !!isAvailable },
    });
    res.json({ artisanProfile: profile });
  } catch (err) {
    next(err);
  }
}

async function uploadAvatar(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { avatarUrl: `/uploads/${req.file.filename}` },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

// Verifies the account name behind a bank account number via Paystack
// before it's saved, so withdrawals never get typo'd into someone else's
// account.
async function linkBankAccount(req, res, next) {
  try {
    const { bankName, bankCode, bankAccountNumber, bankAccountName } = req.body;
    if (!bankName || !/^\d{10}$/.test(String(bankAccountNumber || ""))) {
      return res.status(400).json({ error: "Choose your bank and enter your 10-digit account number." });
    }
    let accountName;
    if (process.env.PAYSTACK_SECRET_KEY) {
      if (!bankCode) return res.status(400).json({ error: "Choose your bank from the list." });
      accountName = (await paystack.resolveBankAccount(bankAccountNumber, bankCode)).account_name;
    } else {
      // Testing period without Paystack: the account name can't be looked
      // up, so the artisan types it as it appears on their bank account.
      accountName = String(bankAccountName || "").trim();
      if (accountName.length < 3) return res.status(400).json({ error: "Enter the account name as it appears at your bank." });
    }
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { bankName, bankAccountNumber: String(bankAccountNumber), bankAccountName: accountName },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

// Used when Paystack isn't configured yet (testing period).
const FALLBACK_BANKS = ["Access Bank", "Citibank Nigeria", "Ecobank Nigeria", "Fidelity Bank", "First Bank of Nigeria", "First City Monument Bank", "Globus Bank", "Guaranty Trust Bank", "Jaiz Bank", "Keystone Bank", "Kuda Bank", "Moniepoint MFB", "OPay", "PalmPay", "Polaris Bank", "Providus Bank", "Stanbic IBTC Bank", "Standard Chartered Bank", "Sterling Bank", "SunTrust Bank", "Titan Trust Bank", "Union Bank of Nigeria", "United Bank For Africa", "Unity Bank", "VFD Microfinance Bank", "Wema Bank", "Zenith Bank"].map((name) => ({ name, code: null }));

async function listBanks(req, res, next) {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) return res.json({ banks: FALLBACK_BANKS, needsAccountName: true });
    const banks = (await paystack.listBanks()).map((b) => ({ name: b.name, code: b.code }));
    res.json({ banks, needsAccountName: false });
  } catch (err) {
    next(err);
  }
}

// "Promote My Page" packages. Paying puts the artisan in the homepage
// "Featured" list until featuredUntil; buying again while still featured
// extends from the current end date rather than from today.
const PROMOTION_PLANS = {
  basic: { label: "Basic Boost", days: 7, priceKobo: 150000 },
  standard: { label: "Standard Boost", days: 30, priceKobo: 450000 },
  vip: { label: "VIP Annual", days: 365, priceKobo: 4000000 },
};

async function promoteMe(req, res, next) {
  try {
    if (!req.user.artisanProfile) return res.status(403).json({ error: "No artisan profile found." });
    const plans = await settings.get("promotion.plans");
    const plan = plans[req.body?.plan];
    if (!plan) return res.status(400).json({ error: "Choose a promotion plan: basic, standard or vip." });

    const profile = await prisma.$transaction(async (tx) => {
      await wallet.debitWallet(req.user.id, plan.priceKobo, "ADJUSTMENT", {
        reference: generateReference("PRM"),
        description: `Promotion: ${plan.label} (${plan.days} days)`,
      }, tx);
      const current = await tx.artisanProfile.findUnique({ where: { id: req.user.artisanProfile.id }, select: { featuredUntil: true } });
      const start = current.featuredUntil && current.featuredUntil > new Date() ? current.featuredUntil : new Date();
      const endsAt = new Date(start.getTime() + plan.days * 24 * 60 * 60 * 1000);
      await tx.featureBoost.create({
        data: { userId: req.user.id, artisanId: req.user.artisanProfile.id, plan: req.body.plan, days: plan.days, amountKobo: plan.priceKobo, startsAt: start, endsAt },
      });
      return tx.artisanProfile.update({ where: { id: req.user.artisanProfile.id }, data: { featuredUntil: endsAt } });
    });
    res.json({ artisanProfile: profile, plan: plan.label });
  } catch (err) {
    next(err);
  }
}

async function listPromotions(req, res, next) {
  try {
    if (!req.user.artisanProfile) return res.status(403).json({ error: "No artisan profile found." });
    const [profile, history] = await Promise.all([
      prisma.artisanProfile.findUnique({ where: { id: req.user.artisanProfile.id }, select: { featuredUntil: true } }),
      prisma.featureBoost.findMany({ where: { artisanId: req.user.artisanProfile.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    const active = !!profile.featuredUntil && profile.featuredUntil > new Date();
    res.json({ plans: await settings.get("promotion.plans"), featuredUntil: profile.featuredUntil, active, history });
  } catch (err) {
    next(err);
  }
}

module.exports = { listPromotions, updateMe, updateArtisanProfile, setAvailability, promoteMe, uploadAvatar, linkBankAccount, listBanks };
