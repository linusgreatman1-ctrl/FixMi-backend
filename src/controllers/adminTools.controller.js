const prisma = require("../config/db");
const { logAdminAction } = require("../services/auditLog.service");

async function listAuditLog(req, res, next) {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const logs = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, take });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
}

// In-app announcement: one Notification per targeted active user, plus a summary row.
async function sendAnnouncement(req, res, next) {
  try {
    const { title, body, roles } = req.body;
    if (!title || !body) return res.status(400).json({ error: "title and body are required." });
    const targetRoles = Array.isArray(roles) ? roles.filter((r) => ["CUSTOMER", "ARTISAN"].includes(r)) : [];
    const users = await prisma.user.findMany({
      where: { status: "ACTIVE", isGuest: false, role: { in: targetRoles.length ? targetRoles : ["CUSTOMER", "ARTISAN"] } },
      select: { id: true },
    });
    const cleanTitle = String(title).slice(0, 120);
    const cleanBody = String(body).slice(0, 1000);
    await prisma.notification.createMany({ data: users.map((u) => ({ userId: u.id, type: "ANNOUNCEMENT", title: cleanTitle, body: cleanBody })) });
    const io = req.app.get("io");
    for (const u of users) io?.to(`user:${u.id}`).emit("notification:new", { type: "ANNOUNCEMENT", title: cleanTitle, body: cleanBody });
    const announcement = await prisma.announcement.create({
      data: { title: cleanTitle, body: cleanBody, targetRoles, sentById: req.user.id, sentByName: req.user.name, recipientCount: users.length },
    });
    await logAdminAction(req.user, "ANNOUNCEMENT_SENT", "Announcement", announcement.id, `${users.length} recipients`);
    res.status(201).json({ announcement });
  } catch (err) {
    next(err);
  }
}

async function listAnnouncements(req, res, next) {
  try {
    res.json({ announcements: await prisma.announcement.findMany({ orderBy: { createdAt: "desc" }, take: 100 }) });
  } catch (err) {
    next(err);
  }
}

module.exports = { listAuditLog, sendAnnouncement, listAnnouncements };
