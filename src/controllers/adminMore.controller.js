const prisma = require("../config/db");
const wallet = require("../services/wallet.service");
const email = require("../services/email.service");
const { notify } = require("../services/notifications.service");
const { logAdminAction } = require("../services/auditLog.service");
const { generateReference } = require("../utils/reference");

const naira = (k) => `₦${Math.round((k || 0) / 100).toLocaleString("en-NG")}`;
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

// ------------------------------------------------------------------ reports

// Business report for a date range (default: last 30 days).
const reports = wrap(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86400000);
  if (isNaN(from) || isNaN(to) || from > to) return bad(res, "Choose a valid date range.");
  to.setHours(23, 59, 59, 999);
  const range = { gte: from, lte: to };

  const [bookings, signups, commissionHolds, withdrawalsPaid, deposits, ratings] = await Promise.all([
    prisma.booking.findMany({ where: { createdAt: range }, select: { category: true, status: true, agreedPriceKobo: true, createdAt: true, artisanId: true } }),
    prisma.user.findMany({ where: { createdAt: range, isGuest: false }, select: { role: true, createdAt: true } }),
    prisma.escrowHold.findMany({ where: { payeeId: null, status: "RELEASED", releasedAt: range }, select: { amountKobo: true, releasedAt: true } }),
    prisma.withdrawal.aggregate({ where: { status: "PAID", processedAt: range }, _sum: { amountKobo: true }, _count: { _all: true } }),
    prisma.transaction.aggregate({ where: { type: "DEPOSIT", createdAt: range }, _sum: { amountKobo: true }, _count: { _all: true } }),
    prisma.rating.aggregate({ where: { createdAt: range, hidden: false, rateeRole: "ARTISAN" }, _avg: { stars: true }, _count: { _all: true } }),
  ]);

  const byDay = {};
  const touch = (d) => (byDay[dayKey(d)] = byDay[dayKey(d)] || { bookings: 0, completed: 0, valueKobo: 0, commissionKobo: 0, signups: 0 });
  bookings.forEach((b) => {
    const r = touch(b.createdAt);
    r.bookings++;
    if (b.status === "CONFIRMED") { r.completed++; r.valueKobo += b.agreedPriceKobo || 0; }
  });
  commissionHolds.forEach((h) => (touch(h.releasedAt).commissionKobo += h.amountKobo));
  signups.forEach((u) => touch(u.createdAt).signups++);

  const byCategory = {};
  bookings.forEach((b) => {
    const c = (byCategory[b.category] = byCategory[b.category] || { category: b.category, bookings: 0, completed: 0, cancelled: 0, valueKobo: 0 });
    c.bookings++;
    if (b.status === "CONFIRMED") { c.completed++; c.valueKobo += b.agreedPriceKobo || 0; }
    if (b.status === "CANCELLED") c.cancelled++;
  });

  const artisanTotals = {};
  bookings.filter((b) => b.status === "CONFIRMED" && b.artisanId).forEach((b) => {
    const a = (artisanTotals[b.artisanId] = artisanTotals[b.artisanId] || { artisanId: b.artisanId, jobs: 0, valueKobo: 0 });
    a.jobs++;
    a.valueKobo += b.agreedPriceKobo || 0;
  });
  const top = Object.values(artisanTotals).sort((a, b) => b.valueKobo - a.valueKobo).slice(0, 10);
  const profiles = await prisma.artisanProfile.findMany({ where: { id: { in: top.map((t) => t.artisanId) } }, select: { id: true, category: true, user: { select: { name: true } } } });
  const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));

  const total = bookings.length;
  const completed = bookings.filter((b) => b.status === "CONFIRMED").length;
  const cancelled = bookings.filter((b) => b.status === "CANCELLED").length;
  res.json({
    range: { from, to },
    totals: {
      bookings: total,
      completed,
      cancelled,
      completionRate: total ? completed / total : 0,
      cancellationRate: total ? cancelled / total : 0,
      jobValueKobo: bookings.filter((b) => b.status === "CONFIRMED").reduce((n, b) => n + (b.agreedPriceKobo || 0), 0),
      commissionKobo: commissionHolds.reduce((n, h) => n + h.amountKobo, 0),
      newCustomers: signups.filter((u) => u.role === "CUSTOMER").length,
      newArtisans: signups.filter((u) => u.role === "ARTISAN").length,
      depositsKobo: deposits._sum.amountKobo || 0,
      depositCount: deposits._count._all,
      withdrawalsPaidKobo: withdrawalsPaid._sum.amountKobo || 0,
      withdrawalsPaidCount: withdrawalsPaid._count._all,
      averageRating: ratings._avg.stars || 0,
      ratingCount: ratings._count._all,
    },
    byDay: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    byCategory: Object.values(byCategory).sort((a, b) => b.bookings - a.bookings),
    topArtisans: top.map((t) => ({ ...t, name: byId[t.artisanId]?.user.name || "", category: byId[t.artisanId]?.category || "" })),
  });
});

// ------------------------------------------------------------ subscriptions

// Corporate plans.
const subscriptions = wrap(async (req, res) => {
  const plans = await prisma.corporatePlan.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(plans.map((p) => p.userId))] } }, select: { id: true, name: true, phone: true, email: true } });
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const now = Date.now();
  res.json({ subscriptions: plans.map((p) => ({ ...p, user: byId[p.userId] || null, active: new Date(p.endsAt).getTime() > now })) });
});

// ------------------------------------------------------------ bank transfers

// Customer-facing half lives in manualPayments.controller; this is the admin queue.
const listManualPayments = wrap(async (req, res) => {
  const status = req.query.status || "PENDING";
  if (!["PENDING", "CONFIRMED", "REJECTED"].includes(status)) return bad(res, "Invalid status.");
  const rows = await prisma.manualPaymentRequest.findMany({
    where: { status },
    orderBy: { createdAt: status === "PENDING" ? "asc" : "desc" },
    take: 200,
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
  });
  res.json({ payments: rows });
});

const confirmManualPayment = wrap(async (req, res) => {
  // Credits the wallet, then does what the transfer was for (top-up, booking escrow or featured boost).
  const result = await require("./payments.controller").confirmManualRequest(req.params.id, req.user.id, req.app.get("io"));
  await logAdminAction(req.user, "MANUAL_PAYMENT_CONFIRMED", "ManualPaymentRequest", result.id, `${naira(result.amountKobo)} ref ${result.reference} (${result.purpose})`);
  const what = result.purpose === "BOOKING_PAYMENT" ? "Your job request is now live." : result.purpose === "FEATURE_BOOST_PAYMENT" ? "Your featured boost is active." : "The money is in your wallet.";
  notify(req.app.get("io"), result.userId, "PAYMENT", "Bank transfer confirmed ✅", `${naira(result.amountKobo)} received. ${what}`, { reference: result.reference }).catch(() => {});
  res.json({ payment: result });
});

const rejectManualPayment = wrap(async (req, res) => {
  const reason = String(req.body.reason || "").trim();
  if (!reason) return bad(res, "Give a reason so the user knows why.");
  const claimed = await prisma.manualPaymentRequest.updateMany({
    where: { id: req.params.id, status: "PENDING" },
    data: { status: "REJECTED", processedById: req.user.id, processedAt: new Date(), rejectionReason: reason },
  });
  if (!claimed.count) return bad(res, "This transfer is already processed or does not exist.", 409);
  const row = await prisma.manualPaymentRequest.findUnique({ where: { id: req.params.id } });
  await logAdminAction(req.user, "MANUAL_PAYMENT_REJECTED", "ManualPaymentRequest", row.id, `${naira(row.amountKobo)}: ${reason}`);
  notify(req.app.get("io"), row.userId, "PAYMENT", "Bank transfer not confirmed", `We could not match your ${naira(row.amountKobo)} transfer. ${reason}`, { reference: row.reference }).catch(() => {});
  res.json({ payment: row });
});

// ---------------------------------------------------------------- live chat

const listChatThreads = wrap(async (req, res) => {
  const threads = await prisma.chatThread.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      participants: { include: { user: { select: { id: true, name: true, role: true, phone: true } } } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
      booking: { select: { id: true, category: true, status: true } },
    },
  });
  threads.sort((a, b) => new Date(b.messages[0]?.createdAt || b.createdAt) - new Date(a.messages[0]?.createdAt || a.createdAt));
  res.json({ threads });
});

const getChatMessages = wrap(async (req, res) => {
  const thread = await prisma.chatThread.findUnique({
    where: { id: req.params.id },
    include: { participants: { include: { user: { select: { id: true, name: true, role: true } } } } },
  });
  if (!thread) return bad(res, "Conversation not found.", 404);
  const messages = await prisma.chatMessage.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" }, take: 500 });
  res.json({ thread, messages });
});

// Admin writes into a conversation (joins it as a participant) so the user
// sees the reply in their normal Messages list.
const sendChatMessage = wrap(async (req, res) => {
  const body = String(req.body.body || "").trim();
  if (!body) return bad(res, "Write a message first.");
  const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id }, include: { participants: true } });
  if (!thread) return bad(res, "Conversation not found.", 404);
  if (!thread.participants.some((p) => p.userId === req.user.id)) {
    await prisma.chatParticipant.create({ data: { threadId: thread.id, userId: req.user.id } });
  }
  const message = await prisma.chatMessage.create({ data: { threadId: thread.id, senderId: req.user.id, body: body.slice(0, 2000) } });
  const io = req.app.get("io");
  io?.to(`chat:${thread.id}`).emit("chat:message", message);
  for (const p of thread.participants) {
    if (p.userId !== req.user.id) notify(io, p.userId, "CHAT", "FixMi support", body.slice(0, 80), { threadId: thread.id }).catch(() => {});
  }
  res.status(201).json({ message });
});

// Opens (or finds) a support conversation between the admin and one user.
const supportThreadForUser = wrap(async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true } });
  if (!target) return bad(res, "User not found.", 404);
  const existing = await prisma.chatThread.findFirst({
    where: { bookingId: null, AND: [{ participants: { some: { userId: target.id } } }, { participants: { some: { userId: req.user.id } } }] },
    select: { id: true },
  });
  if (existing) return res.json({ threadId: existing.id });
  const thread = await prisma.chatThread.create({ data: { participants: { create: [{ userId: target.id }, { userId: req.user.id }] } }, select: { id: true } });
  res.status(201).json({ threadId: thread.id });
});

// --------------------------------------------------------------- bulk email

const sendBulkEmail = wrap(async (req, res) => {
  if (!email.isConfigured()) return bad(res, "Email is not configured yet. Add the SMTP variables on the server.", 503);
  const subject = String(req.body.subject || "").trim();
  const body = String(req.body.body || "").trim();
  if (!subject || !body) return bad(res, "A subject and a message are required.");
  const roles = Array.isArray(req.body.roles) ? req.body.roles.filter((r) => ["CUSTOMER", "ARTISAN"].includes(r)) : [];
  const users = await prisma.user.findMany({
    where: { status: "ACTIVE", isGuest: false, email: { not: null }, role: { in: roles.length ? roles : ["CUSTOMER", "ARTISAN"] } },
    select: { email: true },
  });
  let failed = 0;
  for (const u of users) {
    try {
      await email.sendEmail(u.email, subject, body);
    } catch (e) {
      failed++;
    }
  }
  const record = await prisma.bulkMessage.create({ data: { channel: "EMAIL", subject, body, targetRoles: roles, recipientCount: users.length - failed, failedCount: failed, sentById: req.user.id, sentByName: req.user.name } });
  await logAdminAction(req.user, "BULK_EMAIL", "BulkMessage", record.id, `${users.length - failed} sent, ${failed} failed`);
  res.status(201).json({ message: record });
});

module.exports = {
  reports, subscriptions, listManualPayments, confirmManualPayment, rejectManualPayment,
  listChatThreads, getChatMessages, sendChatMessage, supportThreadForUser, sendBulkEmail, generateReference,
};
