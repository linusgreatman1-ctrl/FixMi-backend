const prisma = require("../config/db");

// Corporate plans keep their own escrow balance, funded from the owner's
// wallet. A corporate job takes its budget from that balance instead of the
// wallet, and anything the job doesn't use goes back to it.
const PLANS = {
  basic: { label: "Basic", priceKobo: 2500000, period: "week", days: 7, callsTotal: 5, maxCategories: 3 },
  standard: { label: "Standard", priceKobo: 8000000, period: "month", days: 30, callsTotal: 20, maxCategories: 6 },
  vip: { label: "VIP Annual", priceKobo: 75000000, period: "year", days: 365, callsTotal: 0, maxCategories: 0 },
};

function activePlanFor(userId, tx = prisma) {
  return tx.corporatePlan.findFirst({ where: { userId, endsAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
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
