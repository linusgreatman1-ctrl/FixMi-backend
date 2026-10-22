const prisma = require("../config/db");
const { notify, notifyAllAdmins } = require("../services/notifications.service");

async function listThreads(req, res, next) {
  try {
    const threads = await prisma.chatThread.findMany({
      where: { participants: { some: { userId: req.user.id } } },
      include: {
        participants: { include: { user: { select: { id: true, name: true, avatarUrl: true, phone: true, role: true } } } },
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

    res.json({ messages, thread: { id: thread.id, closedAt: thread.closedAt, bookingId: thread.bookingId, ticketId: thread.ticketId } });
  } catch (err) {
    next(err);
  }
}

async function sendMessage(req, res, next) {
  try {
    const body = String(req.body.body || "").trim();
    const attachmentUrl = req.body.attachmentUrl && /^\/uploads\/[\w.-]+$/.test(String(req.body.attachmentUrl)) ? String(req.body.attachmentUrl) : null;
    if (!body && !attachmentUrl) return res.status(400).json({ error: "Message body is required." });

    const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id }, include: { participants: true } });
    if (!thread) return res.status(404).json({ error: "Thread not found." });
    if (!thread.participants.some((p) => p.userId === req.user.id)) return res.status(403).json({ error: "Not your conversation." });
    if (thread.closedAt) return res.status(409).json({ error: "This chat has ended." });

    // The same text from the same person in the same chat within 3 seconds is one tap that arrived twice
    // (double tap, Enter + button, a retried request): answer with the message already saved.
    const dup = await prisma.chatMessage.findFirst({
      where: { threadId: thread.id, senderId: req.user.id, body, attachmentUrl, createdAt: { gt: new Date(Date.now() - 3000) } },
      orderBy: { createdAt: "desc" },
    });
    if (dup) return res.status(200).json({ message: dup });

    const message = await prisma.chatMessage.create({ data: { threadId: thread.id, senderId: req.user.id, body, attachmentUrl } });

    const io = req.app.get("io");
    // Every participant (and the sender's other devices) gets it on their own channel, once.
    io?.to([`chat:${thread.id}`, ...thread.participants.map((p) => `user:${p.userId}`)]).emit("chat:message", { ...message, senderName: req.user.name, senderRole: req.user.role });
    const preview = body ? body.slice(0, 80) : "📷 Sent a photo";
    const others = thread.participants.filter((p) => p.userId !== req.user.id);
    for (const p of others) notify(io, p.userId, "CHAT", "New message", preview, { threadId: thread.id }).catch(() => {});
    // A support chat nobody from FixMi has joined yet: tell the admins.
    if (!thread.bookingId && req.user.role !== "ADMIN" && !others.length) {
      notifyAllAdmins(io, "💬 Support chat", `${req.user.name}: ${preview}`, { threadId: thread.id, userId: req.user.id }).catch(() => {});
    }

    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
}

// Either side can end a conversation; it ends for both, live.
async function closeThread(req, res, next) {
  try {
    const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id }, include: { participants: true } });
    if (!thread) return res.status(404).json({ error: "Thread not found." });
    if (!thread.participants.some((p) => p.userId === req.user.id)) return res.status(403).json({ error: "Not your conversation." });
    if (thread.closedAt) return res.json({ thread });
    const updated = await prisma.chatThread.update({ where: { id: thread.id }, data: { closedAt: new Date(), closedBy: req.user.id } });
    req.app.get("io")?.to([`chat:${thread.id}`, ...thread.participants.map((p) => `user:${p.userId}`)]).emit("chat:closed", { threadId: thread.id, closedBy: req.user.id });
    res.json({ thread: updated });
  } catch (err) {
    next(err);
  }
}

// Closes a job's conversation once the job is over (completed, cancelled, declined): chat and call end together.
async function closeBookingThread(io, bookingId) {
  try {
    const thread = await prisma.chatThread.findUnique({ where: { bookingId }, include: { participants: true } });
    if (!thread || thread.closedAt) return;
    await prisma.chatThread.update({ where: { id: thread.id }, data: { closedAt: new Date() } });
    io?.to([`chat:${thread.id}`, ...thread.participants.map((p) => `user:${p.userId}`)]).emit("chat:closed", { threadId: thread.id, auto: true });
  } catch (e) {
    /* best effort */
  }
}

// The caller's own conversation with FixMi Support (one open thread at a time).
async function openSupportThread(req, res, next) {
  try {
    let thread = await prisma.chatThread.findFirst({
      where: { bookingId: null, ticketId: null, closedAt: null, participants: { some: { userId: req.user.id }, none: { userId: { not: req.user.id }, user: { role: { not: "ADMIN" } } } } },
    });
    if (!thread) thread = await prisma.chatThread.create({ data: { participants: { create: [{ userId: req.user.id }] } } });
    res.json({ thread });
  } catch (err) {
    next(err);
  }
}

// A photo for a chat: returns the URL to send as attachmentUrl.
async function uploadAttachment(req, res, next) {
  try {
    const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id }, include: { participants: true } });
    if (!thread) return res.status(404).json({ error: "Thread not found." });
    if (!thread.participants.some((p) => p.userId === req.user.id) && req.user.role !== "ADMIN") return res.status(403).json({ error: "Not your conversation." });
    if (!req.file) return res.status(400).json({ error: "No photo uploaded." });
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  } catch (err) {
    next(err);
  }
}

module.exports = { listThreads, getMessages, sendMessage, closeThread, closeBookingThread, openSupportThread, uploadAttachment };
