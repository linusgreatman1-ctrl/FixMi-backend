const prisma = require("../config/db");

async function notify(io, userId, type, title, body, data) {
  const notification = await prisma.notification.create({ data: { userId, type, title, body, data } });

  if (type !== "SYSTEM") {
    const pref = await prisma.notificationPreference.findUnique({ where: { userId } });
    if (pref && pref.pushEnabled === false) return notification;
  }

  io?.to(`user:${userId}`).emit("notification:new", notification);
  return notification;
}

// Fans a SYSTEM notification out to every active admin — used for new
// artisan sign-ups awaiting KYC review, support tickets, etc.
async function notifyAllAdmins(io, title, body, data) {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  for (const admin of admins) {
    await notify(io, admin.id, "ADMIN", title, body, data).catch(() => {});
  }
}

module.exports = { notify, notifyAllAdmins };
