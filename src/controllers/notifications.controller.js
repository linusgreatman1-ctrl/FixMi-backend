const prisma = require("../config/db");

async function list(req, res, next) {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ notifications });
  } catch (err) {
    next(err);
  }
}

async function markRead(req, res, next) {
  try {
    const notification = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { readAt: new Date() },
    });
    res.json({ success: notification.count > 0 });
  } catch (err) {
    next(err);
  }
}

async function markAllRead(req, res, next) {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, markRead, markAllRead };
