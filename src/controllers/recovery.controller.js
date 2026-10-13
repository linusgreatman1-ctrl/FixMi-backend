const crypto = require("crypto");
const prisma = require("../config/db");
const { hashPassword, isStrongPassword } = require("../utils/password");
const sms = require("../services/sms.service");
const email = require("../services/email.service");

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const hashCode = (userId, code) => crypto.createHash("sha256").update(`${userId}:${code}:${process.env.JWT_ACCESS_SECRET || ""}`).digest("hex");

async function findAccount(body) {
  const em = body.email ? String(body.email).trim().toLowerCase() : null;
  const ph = body.phone ? String(body.phone).trim() : null;
  if (!em && !ph) return null;
  return prisma.user.findFirst({ where: em ? { email: { equals: em, mode: "insensitive" } } : { phone: ph } });
}

// Always answers the same way so the endpoint can't be used to find out who has an account.
async function forgotPassword(req, res, next) {
  try {
    const reply = { ok: true, message: "If that account exists, a reset code is on its way." };
    if (!req.body.email && !req.body.phone) return res.status(400).json({ error: "Enter your email or phone number." });
    const user = await findAccount(req.body);
    if (!user || user.status !== "ACTIVE" || !user.passwordHash || user.role === "ADMIN") return res.json(reply);

    const recent = await prisma.passwordReset.count({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 60 * 1000) } } });
    if (recent) return res.json(reply);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    await prisma.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } });
    await prisma.passwordReset.create({ data: { userId: user.id, codeHash: hashCode(user.id, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) } });

    const text = `Your FixMi password reset code is ${code}. It expires in 15 minutes. If you did not ask for this, ignore this message.`;
    let delivered = false;
    if (user.phone && sms.isConfigured()) delivered = await sms.sendSms(user.phone, text).then(() => true, () => false);
    if (!delivered && user.email && email.isConfigured()) delivered = await email.sendEmail(user.email, "Your FixMi reset code", text).then(() => true, () => false);
    // No SMS/email provider yet: the code is only in the server log, so an operator can read it out to a verified user.
    if (!delivered) console.log(`[password-reset] no delivery channel configured; code for user ${user.id}: ${code}`);
    res.json(reply);
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { code, newPassword } = req.body;
    if (!code || !isStrongPassword(newPassword)) return res.status(400).json({ error: "Enter the code and a new password of at least 6 characters." });
    const invalid = () => res.status(400).json({ error: "That code is wrong or has expired." });
    const user = await findAccount(req.body);
    if (!user) return invalid();
    const reset = await prisma.passwordReset.findFirst({ where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
    if (!reset || reset.attempts >= MAX_ATTEMPTS) return invalid();

    const expected = Buffer.from(reset.codeHash);
    const given = Buffer.from(hashCode(user.id, String(code).trim()));
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      await prisma.passwordReset.update({ where: { id: reset.id }, data: { attempts: { increment: 1 } } });
      return invalid();
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } }),
      prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revoked: true } }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { forgotPassword, resetPassword };
