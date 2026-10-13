const prisma = require("../config/db");
const { notifyAllAdmins } = require("../services/notifications.service");

async function createTicket(req, res, next) {
  try {
    const { subject, message, bookingId, category, evidenceUrl } = req.body;
    if (!subject || !message) return res.status(400).json({ error: "subject and message are required." });
    if (bookingId) {
      const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { artisan: { select: { userId: true } } } });
      if (!booking || (booking.customerId !== req.user.id && booking.artisan?.userId !== req.user.id)) {
        return res.status(403).json({ error: "You can only report your own jobs." });
      }
    }

    const ticket = await prisma.supportTicket.create({
      data: { userId: req.user.id, subject: String(subject).slice(0, 160), message: String(message).slice(0, 4000), bookingId: bookingId || null, category: category || null, evidenceUrl: evidenceUrl || null },
    });
    notifyAllAdmins(req.app.get("io"), "🎫 New support ticket", `${req.user.name}: ${subject}`, { ticketId: ticket.id }).catch(() => {});
    res.status(201).json({ ticket });
  } catch (err) {
    next(err);
  }
}

async function listMyTickets(req, res, next) {
  try {
    const tickets = await prisma.supportTicket.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
    res.json({ tickets });
  } catch (err) {
    next(err);
  }
}

// Photo evidence for a report or dispute. Returns a URL the ticket stores.
async function uploadEvidence(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  } catch (err) {
    next(err);
  }
}

module.exports = { createTicket, listMyTickets, uploadEvidence };
