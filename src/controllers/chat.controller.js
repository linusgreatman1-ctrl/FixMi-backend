const prisma = require("../config/db");
const { notify } = require("../services/notifications.service");

async function listThreads(req, res, next) {
  try {
    const threads = await prisma.chatThread.findMany({
      where: { participants: { some: { userId: req.user.id } } },
      include: {
        participants: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
        booking: { select: { id: true, category: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ threads });
  } catch (err) {
    next(err);
  }
}

async function getMessages(req, res, next) {
  try {
    const thread = await prisma.chatThread.findUnique({
      where: { id: req.params.id },
      include: { participants: true },
    });
    if (!thread) return res.status(404).json({ error: "Thread not found." });
    if (!thread.participants.some((p) => p.userId === req.user.id)) return res.status(403).json({ error: "Not your conversation." });

    const messages = await prisma.chatMessage.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" } });
    await prisma.chatMessage.updateMany({ where: { threadId: thread.id, senderId: { not: req.user.id }, readAt: null }, data: { readAt: new Date() } });

    res.json({ messages });
  } catch (err) {
    next(err);
  }
}

async function sendMessage(req, res, next) {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: "Message body is required." });

    const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id }, include: { participants: true } });
    if (!thread) return res.status(404).json({ error: "Thread not found." });
    if (!thread.participants.some((p) => p.userId === req.user.id)) return res.status(403).json({ error: "Not your conversation." });

    const message = await prisma.chatMessage.create({ data: { threadId: thread.id, senderId: req.user.id, body: body.trim() } });

    const io = req.app.get("io");
    io?.to(`chat:${thread.id}`).emit("chat:message", message);
    for (const p of thread.participants) {
      if (p.userId === req.user.id) continue;
      notify(io, p.userId, "CHAT", "New message", body.trim().slice(0, 80), { threadId: thread.id }).catch(() => {});
    }

    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
}

module.exports = { listThreads, getMessages, sendMessage };
