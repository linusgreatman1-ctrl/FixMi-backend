const prisma = require("../config/db");
const { notifyAllAdmins } = require("../services/notifications.service");

async function createTicket(req, res, next) {
  try {
    const { subject, message, bookingId } = req.body;
    if (!subject || !message) return res.status(400).json({ error: "subject and message are required." });

    const ticket = await prisma.supportTicket.create({
      data: { userId: req.user.id, subject, message, bookingId: bookingId || null },
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

module.exports = { createTicket, listMyTickets };
