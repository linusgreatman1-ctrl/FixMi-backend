const prisma = require("../config/db");
const { hashPassword, comparePassword } = require("../utils/password");

// Lets the owner sign in to /admin without a seed or a database console:
// set ADMIN_EMAIL and ADMIN_PASSWORD on the server and that account becomes
// an active admin with that password on the next start.
async function ensureAdminFromEnv() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || password.length < 8) return;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    await prisma.user.create({ data: { name: "FixMi Admin", email, role: "ADMIN", status: "ACTIVE", isSuperAdmin: true, passwordHash: await hashPassword(password) } });
    console.log("[admin] admin account created from ADMIN_EMAIL");
    return;
  }
  const samePassword = existing.passwordHash && (await comparePassword(password, existing.passwordHash));
  await prisma.user.update({
    where: { id: existing.id },
    data: { role: "ADMIN", status: "ACTIVE", isSuperAdmin: true, ...(samePassword ? {} : { passwordHash: await hashPassword(password) }) },
  });
  console.log("[admin] admin account ready for ADMIN_EMAIL");
}

module.exports = { ensureAdminFromEnv };
