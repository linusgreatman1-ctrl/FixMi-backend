const prisma = require("../config/db");

// Corporate plans keep their own escrow balance, funded from the owner's
// wallet. A corporate job takes its budget from that balance instead of the
// wallet, and anything the job doesn't use goes back to it.
const PLANS = {
  basic: { label: "Basic", priceKobo: 2500000, period: "week", days: 7, callsTotal: 5, maxCategories: 3 },
  standard: { label: "Standard", priceKobo: 8000000, period: "month", days: 30, callsTotal: 20, maxCategories: 6 },
  vip: { label: "VIP Annual", priceKobo: 75000000, period: "year", days: 365, callsTotal: 0, maxCategories: 0 },
};

const PERIOD_DAYS = { week: 7, month: 30, year: 365 };

// A funded plan stays active until its escrow is used up or the customer ends it. When a period runs out
// with money still in the escrow, the plan rolls into a new period: the balance is kept and the calls renew.
async function activePlanFor(userId, tx = prisma) {
  const now = new Date();
  const plan = await tx.corporatePlan.findFirst({
    where: { userId, OR: [{ endsAt: { gt: now } }, { escrowKobo: { gt: 0 } }] },
    orderBy: { createdAt: "desc" },
  });
  if (!plan || plan.endsAt > now) return plan;
  const days = PERIOD_DAYS[plan.period] || 30;
  let ends = new Date(plan.endsAt);
  while (ends <= now) ends = new Date(ends.getTime() + days * 86400000);
  return tx.corporatePlan.update({ where: { id: plan.id }, data: { endsAt: ends, callsUsed: 0 } });
}

function callsLeft(plan) {
  return plan.callsTotal === 0 ? null : Math.max(0, plan.callsTotal - plan.callsUsed);
}

function coversCategory(plan, category) {
  return !plan.categories.length || plan.categories.includes(category);
}

async function debitPlan(tx, planId, amountKobo) {
  const plan = await tx.corporatePlan.findUnique({ where: { id: planId } });
  if (!plan) throw Object.assign(new Error("Corporate plan not found."), { status: 404 });
  if (plan.escrowKobo < amountKobo) {
    throw Object.assign(new Error("Your corporate escrow is too low for this job. Top it up first."), { status: 400, shortfallKobo: amountKobo - plan.escrowKobo });
  }
  return tx.corporatePlan.update({ where: { id: planId }, data: { escrowKobo: { decrement: amountKobo } } });
}

function creditPlan(tx, planId, amountKobo) {
  return tx.corporatePlan.update({ where: { id: planId }, data: { escrowKobo: { increment: amountKobo } } });
}

module.exports = { PLANS, activePlanFor, callsLeft, coversCategory, debitPlan, creditPlan };
