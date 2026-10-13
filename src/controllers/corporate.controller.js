const prisma = require("../config/db");
const wallet = require("../services/wallet.service");
const corporate = require("../services/corporate.service");
const { notify } = require("../services/notifications.service");
const { generateReference } = require("../utils/reference");
const settings = require("../services/settings.service");

function view(plan) {
  if (!plan) return null;
  return { ...plan, callsLeft: corporate.callsLeft(plan), daysLeft: Math.max(0, Math.ceil((new Date(plan.endsAt) - Date.now()) / 86400000)) };
}

// The corporate dashboard: plan catalogue, the active plan and its jobs.
async function getCorporate(req, res, next) {
  try {
    const plan = await corporate.activePlanFor(req.user.id);
    const jobs = plan
      ? await prisma.booking.findMany({
          where: { corporatePlanId: plan.id },
          include: { artisan: { select: { id: true, category: true, user: { select: { name: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 50,
        })
      : [];
    const spentKobo = jobs.filter((j) => ["COMPLETED", "CONFIRMED", "DISPUTED"].includes(j.status)).reduce((n, j) => n + (j.agreedPriceKobo || 0), 0);
    const reservedKobo = jobs.filter((j) => !["COMPLETED", "CONFIRMED", "DISPUTED", "CANCELLED", "DECLINED"].includes(j.status)).reduce((n, j) => n + (j.escrowKobo || 0), 0);
    res.json({ plans: await settings.get("corporate.plans"), plan: view(plan), jobs, spentKobo, reservedKobo });
  } catch (err) {
    next(err);
  }
}

// Subscribing moves the plan price from the wallet into the plan's escrow.
async function subscribe(req, res, next) {
  try {
    const key = String(req.body?.plan || "").toLowerCase();
    const def = (await settings.get("corporate.plans"))[key];
    if (!def) return res.status(400).json({ error: "Choose Basic, Standard or VIP Annual." });
    const categories = Array.isArray(req.body?.categories) ? [...new Set(req.body.categories.map(String).filter(Boolean))] : [];
    if (def.maxCategories && !categories.length) return res.status(400).json({ error: "Select the services your business needs." });
    if (def.maxCategories && categories.length > def.maxCategories) {
      return res.status(400).json({ error: `The ${def.label} plan covers up to ${def.maxCategories} services.` });
    }
    if (await corporate.activePlanFor(req.user.id)) return res.status(409).json({ error: "You already have an active corporate plan." });

    const plan = await prisma.$transaction(async (tx) => {
      const created = await tx.corporatePlan.create({
        data: {
          userId: req.user.id,
          plan: key,
          label: def.label,
          priceKobo: def.priceKobo,
          period: def.period,
          callsTotal: def.callsTotal,
          categories: def.maxCategories ? categories : [],
          escrowKobo: def.priceKobo,
          endsAt: new Date(Date.now() + def.days * 86400000),
        },
      });
      await wallet.debitWallet(req.user.id, def.priceKobo, "ESCROW_HOLD", { reference: generateReference("CRP"), description: `${def.label} corporate plan escrow` }, tx);
      return created;
    });
    notify(req.app.get("io"), req.user.id, "PAYMENT", "Corporate plan active", `Your ${def.label} plan is active and its escrow is funded.`, {}).catch(() => {});
    res.status(201).json({ plan: view(plan) });
  } catch (err) {
    next(err);
  }
}

async function topUp(req, res, next) {
  try {
    const amountKobo = Math.round(Number(req.body?.amountKobo));
    if (!Number.isFinite(amountKobo) || amountKobo < 100000) return res.status(400).json({ error: "The minimum top-up is ₦1,000." });
    const plan = await corporate.activePlanFor(req.user.id);
    if (!plan) return res.status(409).json({ error: "You don't have an active corporate plan." });
    const updated = await prisma.$transaction(async (tx) => {
      await wallet.debitWallet(req.user.id, amountKobo, "ESCROW_HOLD", { reference: generateReference("CRP"), description: "Corporate escrow top-up" }, tx);
      return corporate.creditPlan(tx, plan.id, amountKobo);
    });
    res.json({ plan: view(updated) });
  } catch (err) {
    next(err);
  }
}

// Ends the plan now and returns the unused escrow to the wallet. Jobs still
// running keep the money already reserved for them.
async function cancelPlan(req, res, next) {
  try {
    const plan = await corporate.activePlanFor(req.user.id);
    if (!plan) return res.status(409).json({ error: "You don't have an active corporate plan." });
    const refunded = plan.escrowKobo;
    await prisma.$transaction(async (tx) => {
      if (refunded > 0) {
        await wallet.creditWallet(req.user.id, refunded, "ESCROW_REFUND", { reference: generateReference("CRP"), description: "Unused corporate escrow returned" }, tx);
      }
      await tx.corporatePlan.update({ where: { id: plan.id }, data: { escrowKobo: 0, endsAt: new Date() } });
    });
    res.json({ ok: true, refundedKobo: refunded });
  } catch (err) {
    next(err);
  }
}

module.exports = { getCorporate, subscribe, topUp, cancelPlan };
