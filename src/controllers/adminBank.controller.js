const prisma = require("../config/db");
const bank = require("../services/bankCredit.service");
const { logAdminAction } = require("../services/auditLog.service");

// Money that arrived in the account and the system could not tie to one request, with the requests still waiting for money.
async function listBankCredits(req, res, next) {
  try {
    const credits = await prisma.bankCredit.findMany({ where: { status: { in: ["UNMATCHED", "AMBIGUOUS"] } }, orderBy: { createdAt: "desc" }, take: 50 });
    const waiting = await bank.waiting();
    res.json({ credits, waiting: waiting.map((r) => ({ id: r.id, ref: r.ref, amountKobo: r.amountKobo, holder: r.holder, label: r.label })) });
  } catch (err) { next(err); }
}

async function matchBankCredit(req, res, next) {
  try {
    const out = await bank.matchByHand(req.params.id, String((req.body && req.body.requestId) || ""), req.app.get("io"));
    if (!out.ok) return res.status(409).json({ error: out.reason === "request_not_waiting" ? "That request is not waiting any more." : "Could not match it (" + out.reason + ")." });
    await logAdminAction(req.user, "BANK_CREDIT_MATCHED", "BankCredit", req.params.id, "matched by hand");
    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = { listBankCredits, matchBankCredit };
