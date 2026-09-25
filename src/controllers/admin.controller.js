const prisma = require("../config/db");
const { notify } = require("../services/notifications.service");

async function stats(req, res, next) {
  try {
    const [customers, artisans, pendingArtisans, bookingsTotal, bookingsActive, ticketsOpen] = await Promise.all([
      prisma.user.count({ where: { role: "CUSTOMER" } }),
      prisma.artisanProfile.count(),
      prisma.artisanProfile.count({ where: { kycStatus: "PENDING" } }),
      prisma.booking.count(),
      prisma.booking.count({ where: { status: { in: ["REQUESTED", "ACCEPTED", "PAID", "IN_PROGRESS"] } } }),
      prisma.supportTicket.count({ where: { status: "OPEN" } }),
    ]);
    res.json({ customers, artisans, pendingArtisans, bookingsTotal, bookingsActive, ticketsOpen });
  } catch (err) {
    next(err);
  }
}

async function listPendingArtisans(req, res, next) {
  try {
    const artisans = await prisma.artisanProfile.findMany({
      where: { kycStatus: "PENDING" },
      include: { user: { select: { id: true, name: true, email: true, phone: true, createdAt: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json({ artisans });
  } catch (err) {
    next(err);
  }
}

async function approveArtisan(req, res, next) {
  try {
    const artisan = await prisma.artisanProfile.update({
      where: { id: req.params.id },
      data: { kycStatus: "APPROVED", isVerified: true, kycNote: null },
      include: { user: true },
    });
    notify(req.app.get("io"), artisan.userId, "ADMIN", "You're verified! ✅", "Your artisan profile was approved. You can now go online and receive jobs.", {
      artisanId: artisan.id,
    }).catch(() => {});
    res.json({ artisan });
  } catch (err) {
    next(err);
  }
}

async function rejectArtisan(req, res, next) {
  try {
    const { reason } = req.body;
    const artisan = await prisma.artisanProfile.update({
      where: { id: req.params.id },
      data: { kycStatus: "REJECTED", isVerified: false, kycNote: reason || null },
    });
    notify(req.app.get("io"), artisan.userId, "ADMIN", "Verification declined", reason || "Your artisan application was declined.", {
      artisanId: artisan.id,
    }).catch(() => {});
    res.json({ artisan });
  } catch (err) {
    next(err);
  }
}

async function listUsers(req, res, next) {
  try {
    const { role } = req.query;
    const users = await prisma.user.findMany({
      where: role ? { role } : undefined,
      select: { id: true, name: true, email: true, phone: true, role: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ users });
  } catch (err) {
    next(err);
  }
}

async function suspendUser(req, res, next) {
  try {
    const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: "SUSPENDED" } });
    res.json({ user: { id: user.id, status: user.status } });
  } catch (err) {
    next(err);
  }
}

async function reactivateUser(req, res, next) {
  try {
    const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: "ACTIVE" } });
    res.json({ user: { id: user.id, status: user.status } });
  } catch (err) {
    next(err);
  }
}

async function listBookings(req, res, next) {
  try {
    const { status } = req.query;
    const bookings = await prisma.booking.findMany({
      where: status ? { status } : undefined,
      include: {
        customer: { select: { id: true, name: true } },
        artisan: { select: { id: true, category: true, user: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ bookings });
  } catch (err) {
    next(err);
  }
}

async function listTickets(req, res, next) {
  try {
    const { status } = req.query;
    const tickets = await prisma.supportTicket.findMany({
      where: status ? { status } : undefined,
      include: { user: { select: { id: true, name: true, email: true, phone: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ tickets });
  } catch (err) {
    next(err);
  }
}

async function updateTicket(req, res, next) {
  try {
    const { status } = req.body;
    if (!["OPEN", "IN_REVIEW", "RESOLVED"].includes(status)) return res.status(400).json({ error: "Invalid status." });
    const ticket = await prisma.supportTicket.update({ where: { id: req.params.id }, data: { status } });
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  stats,
  listPendingArtisans,
  approveArtisan,
  rejectArtisan,
  listUsers,
  suspendUser,
  reactivateUser,
  listBookings,
  listTickets,
  updateTicket,
};
