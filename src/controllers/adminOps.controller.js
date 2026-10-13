const prisma = require("../config/db");
const wallet = require("../services/wallet.service");
const settings = require("../services/settings.service");
const sms = require("../services/sms.service");
const { notify } = require("../services/notifications.service");
const { logAdminAction } = require("../services/auditLog.service");
const { generateReference } = require("../utils/reference");
const { hashPassword } = require("../utils/password");

const naira = (k) => `₦${Math.round((k || 0) / 100).toLocaleString("en-NG")}`;
const pageOf = (req, def = 50) => ({ take: Math.min(parseInt(req.query.limit, 10) || def, 200), skip: parseInt(req.query.offset, 10) || 0 });
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------------------------------------------------------------- dashboard

const dashboard = wrap(async (req, res) => {
  const since7 = new Date(Date.now() - 7 * 86400000);
  const since14 = new Date(Date.now() - 14 * 86400000);
  const [customers, artisans, online, newUsers7, bookingsByStatus, gmv, commission, held, wdPending, ticketsOpen, disputesOpen, kycPending, sosOpen, reportsOpen, recentUsers, recentBookings] = await Promise.all([
    prisma.user.count({ where: { role: "CUSTOMER", isGuest: false } }),
    prisma.artisanProfile.count(),
    prisma.artisanProfile.count({ where: { isAvailable: true } }),
    prisma.user.count({ where: { createdAt: { gte: since7 }, isGuest: false } }),
    prisma.booking.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.booking.aggregate({ where: { status: "CONFIRMED" }, _sum: { agreedPriceKobo: true } }),
    prisma.escrowHold.aggregate({ where: { payeeId: null, status: "RELEASED" }, _sum: { amountKobo: true } }),
    prisma.escrowHold.aggregate({ where: { status: { in: ["HELD", "DISPUTED"] } }, _sum: { amountKobo: true } }),
    prisma.withdrawal.aggregate({ where: { status: { in: ["PENDING", "PROCESSING"] } }, _count: { _all: true }, _sum: { amountKobo: true } }),
    prisma.supportTicket.count({ where: { status: "OPEN", isDispute: false } }),
    prisma.supportTicket.count({ where: { isDispute: true, resolvedAt: null } }),
    prisma.kycDocument.count({ where: { status: "PENDING" } }),
    prisma.safetyReport.count({ where: { type: "SOS", status: { not: "RESOLVED" } } }),
    prisma.safetyReport.count({ where: { type: { not: "SOS" }, status: { not: "RESOLVED" } } }),
    prisma.user.findMany({ where: { createdAt: { gte: since14 }, isGuest: false }, select: { createdAt: true } }),
    prisma.booking.findMany({ where: { createdAt: { gte: since14 } }, select: { createdAt: true } }),
  ]);
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const series = {};
  for (let i = 13; i >= 0; i--) series[day(Date.now() - i * 86400000)] = { signups: 0, bookings: 0 };
  recentUsers.forEach((u) => series[day(u.createdAt)] && series[day(u.createdAt)].signups++);
  recentBookings.forEach((b) => series[day(b.createdAt)] && series[day(b.createdAt)].bookings++);
  res.json({
    users: { customers, artisans, artisansOnline: online, newLast7Days: newUsers7 },
    bookings: Object.fromEntries(bookingsByStatus.map((r) => [r.status, r._count._all])),
    money: {
      completedValueKobo: gmv._sum.agreedPriceKobo || 0,
      commissionEarnedKobo: commission._sum.amountKobo || 0,
      inEscrowKobo: held._sum.amountKobo || 0,
      pendingWithdrawals: { count: wdPending._count._all, amountKobo: wdPending._sum.amountKobo || 0 },
    },
    needsAttention: { supportTickets: ticketsOpen, disputes: disputesOpen, idReviews: kycPending, sos: sosOpen, safetyReports: reportsOpen, withdrawals: wdPending._count._all },
    series: Object.entries(series).map(([date, v]) => ({ date, ...v })),
  });
});

// -------------------------------------------------------------------- users

const listUsers = wrap(async (req, res) => {
  const { role, status, q } = req.query;
  const where = {
    ...(role && { role }),
    ...(status && { status }),
    ...(q && { OR: [{ name: { contains: String(q), mode: "insensitive" } }, { email: { contains: String(q), mode: "insensitive" } }, { phone: { contains: String(q) } }] }),
  };
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: { id: true, name: true, email: true, phone: true, role: true, status: true, isGuest: true, createdAt: true, lastLoginAt: true, artisanProfile: { select: { category: true, isVerified: true, kycStatus: true } }, wallet: { select: { balanceKobo: true } } },
      orderBy: { createdAt: "desc" },
      ...pageOf(req),
    }),
    prisma.user.count({ where }),
  ]);
  res.json({ users, total });
});

const getUser = wrap(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, name: true, email: true, phone: true, role: true, status: true, isGuest: true, isSuperAdmin: true, avatarUrl: true, address: true, state: true, lga: true,
      bankName: true, bankAccountNumber: true, bankAccountName: true, createdAt: true, lastLoginAt: true,
      artisanProfile: true, wallet: { select: { id: true, balanceKobo: true } },
      kycDocuments: { select: { id: true, docType: true, idType: true, idNumber: true, status: true, rejectionReason: true, createdAt: true }, orderBy: { createdAt: "desc" } },
      emergencyContacts: { select: { name: true, phone: true, relationship: true } },
      supportTickets: { orderBy: { createdAt: "desc" }, take: 10, select: { id: true, subject: true, status: true, isDispute: true, createdAt: true } },
      safetyReports: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!user) return bad(res, "User not found.", 404);
  const [bookingsAsCustomer, bookingsAsArtisan, recentBookings, transactions] = await Promise.all([
    prisma.booking.count({ where: { customerId: user.id } }),
    user.artisanProfile ? prisma.booking.count({ where: { artisanId: user.artisanProfile.id } }) : 0,
    prisma.booking.findMany({
      where: { OR: [{ customerId: user.id }, ...(user.artisanProfile ? [{ artisanId: user.artisanProfile.id }] : [])] },
      orderBy: { createdAt: "desc" }, take: 10, select: { id: true, category: true, status: true, agreedPriceKobo: true, createdAt: true },
    }),
    user.wallet ? prisma.transaction.findMany({ where: { walletId: user.wallet.id }, orderBy: { createdAt: "desc" }, take: 15 }) : [],
  ]);
  res.json({ user, bookingsAsCustomer, bookingsAsArtisan, recentBookings, transactions });
});

const setUserStatus = wrap(async (req, res) => {
  const { status, reason } = req.body;
  if (!["ACTIVE", "SUSPENDED"].includes(status)) return bad(res, "status must be ACTIVE or SUSPENDED.");
  if (req.params.id === req.user.id) return bad(res, "You cannot change your own account status.");
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, role: true, isSuperAdmin: true } });
  if (!target) return bad(res, "User not found.", 404);
  if (target.role === "ADMIN" && !req.user.isSuperAdmin) return bad(res, "Only a super admin can change an admin account.", 403);
  const user = await prisma.user.update({ where: { id: target.id }, data: { status } });
  if (status === "SUSPENDED") await prisma.refreshToken.updateMany({ where: { userId: target.id }, data: { revoked: true } });
  await logAdminAction(req.user, status === "SUSPENDED" ? "USER_SUSPENDED" : "USER_REACTIVATED", "User", target.id, [target.name, reason].filter(Boolean).join(" — "));
  res.json({ user: { id: user.id, status: user.status } });
});

// Super admin only. Adds or removes money with a mandatory reason; always recorded.
const adjustWallet = wrap(async (req, res) => {
  const amountKobo = Math.round(Number(req.body.amountKobo));
  const reason = String(req.body.reason || "").trim();
  if (!Number.isFinite(amountKobo) || amountKobo === 0) return bad(res, "amountKobo must be a non-zero number (negative to deduct).");
  if (Math.abs(amountKobo) > 100000000) return bad(res, "Adjustments are limited to ₦1,000,000 at a time.");
  if (!reason) return bad(res, "A reason is required.");
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } });
  if (!target) return bad(res, "User not found.", 404);
  const reference = generateReference("ADJ");
  const result = await prisma.$transaction(async (tx) => {
    if (amountKobo > 0) return wallet.creditWallet(target.id, amountKobo, "ADJUSTMENT", { reference, description: `Admin adjustment: ${reason}` }, tx);
    const w = await wallet.getOrCreateWallet(target.id, tx);
    if (w.balanceKobo < -amountKobo) throw Object.assign(new Error("The wallet does not hold that much."), { status: 400 });
    return wallet.debitWallet(target.id, -amountKobo, "ADJUSTMENT", { reference, description: `Admin adjustment: ${reason}` }, tx);
  });
  await logAdminAction(req.user, "WALLET_ADJUSTMENT", "User", target.id, `${amountKobo > 0 ? "+" : "-"}${naira(Math.abs(amountKobo))} — ${reason}`);
  notify(req.app.get("io"), target.id, "PAYMENT", "Wallet updated", `${amountKobo > 0 ? naira(amountKobo) + " was added to" : naira(-amountKobo) + " was deducted from"} your wallet. ${reason}`, { reference }).catch(() => {});
  res.json({ balanceKobo: result.balanceKobo, reference });
});

// Super admin only. Only accounts with no money or job history can be removed; otherwise suspend.
const deleteUser = wrap(async (req, res) => {
  if (req.params.id === req.user.id) return bad(res, "You cannot delete your own account.");
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { wallet: true, artisanProfile: { select: { id: true } } } });
  if (!target) return bad(res, "User not found.", 404);
  if (target.role === "ADMIN") return bad(res, "Remove admins from the Admins tab.");
  const jobs = await prisma.booking.count({ where: { OR: [{ customerId: target.id }, ...(target.artisanProfile ? [{ artisanId: target.artisanProfile.id }] : [])] } });
  const txs = target.wallet ? await prisma.transaction.count({ where: { walletId: target.wallet.id } }) : 0;
  if (jobs || txs || (target.wallet && target.wallet.balanceKobo)) return bad(res, "This account has job or money history. Suspend it instead.", 409);
  await prisma.user.delete({ where: { id: target.id } });
  await logAdminAction(req.user, "USER_DELETED", "User", target.id, target.name);
  res.json({ ok: true });
});

// -------------------------------------------------------------- withdrawals

const listWithdrawals = wrap(async (req, res) => {
  const status = req.query.status;
  if (status && !["PENDING", "PROCESSING", "PAID", "FAILED"].includes(status)) return bad(res, "Invalid status.");
  const withdrawals = await prisma.withdrawal.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    ...pageOf(req),
  });
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(withdrawals.map((w) => w.userId))] } },
    select: { id: true, name: true, phone: true, bankName: true, bankAccountNumber: true, bankAccountName: true },
  });
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  res.json({ withdrawals: withdrawals.map((w) => ({ ...w, user: byId[w.userId] || null })) });
});

// Admin has sent the money from the company bank account and records it here.
const payWithdrawal = wrap(async (req, res) => {
  const note = String(req.body.note || "").trim() || null;
  const result = await prisma.withdrawal.updateMany({
    where: { id: req.params.id, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "PAID", processedAt: new Date(), processedById: req.user.id, adminNote: note },
  });
  if (!result.count) return bad(res, "This withdrawal is already processed or does not exist.", 409);
  const w = await prisma.withdrawal.findUnique({ where: { id: req.params.id } });
  await logAdminAction(req.user, "WITHDRAWAL_PAID", "Withdrawal", w.id, `${naira(w.amountKobo)}${note ? " — " + note : ""}`);
  notify(req.app.get("io"), w.userId, "PAYMENT", "Withdrawal paid ✅", `${naira(w.amountKobo)} has been sent to your bank account.`, { withdrawalId: w.id }).catch(() => {});
  res.json({ withdrawal: w });
});

// Declines the payout and puts the money back in the user's wallet.
const rejectWithdrawal = wrap(async (req, res) => {
  const reason = String(req.body.reason || "").trim();
  if (!reason) return bad(res, "Give a reason so the user knows why.");
  const w = await prisma.$transaction(async (tx) => {
    const claimed = await tx.withdrawal.updateMany({
      where: { id: req.params.id, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", processedAt: new Date(), processedById: req.user.id, rejectionReason: reason },
    });
    if (!claimed.count) throw Object.assign(new Error("This withdrawal is already processed or does not exist."), { status: 409 });
    const row = await tx.withdrawal.findUnique({ where: { id: req.params.id } });
    await wallet.creditWallet(row.userId, row.amountKobo, "ADJUSTMENT", { reference: generateReference("WDR"), description: `Withdrawal declined: ${reason}` }, tx);
    return row;
  });
  await logAdminAction(req.user, "WITHDRAWAL_REJECTED", "Withdrawal", w.id, `${naira(w.amountKobo)} — ${reason}`);
  notify(req.app.get("io"), w.userId, "PAYMENT", "Withdrawal declined", `${naira(w.amountKobo)} was returned to your wallet. ${reason}`, { withdrawalId: w.id }).catch(() => {});
  res.json({ withdrawal: w });
});

// ---------------------------------------------------------- money overviews

const listTransactions = wrap(async (req, res) => {
  const { type, userId } = req.query;
  const where = { ...(type && { type }), ...(userId && { wallet: { userId } }) };
  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { wallet: { select: { user: { select: { id: true, name: true } } } } },
    ...pageOf(req),
  });
  res.json({ transactions });
});

const listEscrow = wrap(async (req, res) => {
  const status = req.query.status;
  if (status && !["HELD", "RELEASED", "REFUNDED", "DISPUTED"].includes(status)) return bad(res, "Invalid status.");
  const holds = await prisma.escrowHold.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    include: { booking: { select: { id: true, category: true, status: true } } },
    ...pageOf(req),
  });
  const totals = await prisma.escrowHold.groupBy({ by: ["status"], _sum: { amountKobo: true }, _count: { _all: true } });
  res.json({ holds, totals: totals.map((t) => ({ status: t.status, count: t._count._all, amountKobo: t._sum.amountKobo || 0 })) });
});

const listCommissions = wrap(async (req, res) => {
  const holds = await prisma.escrowHold.findMany({
    where: { payeeId: null, status: "RELEASED" },
    orderBy: { releasedAt: "desc" },
    include: { booking: { select: { id: true, category: true } } },
    ...pageOf(req),
  });
  const total = await prisma.escrowHold.aggregate({ where: { payeeId: null, status: "RELEASED" }, _sum: { amountKobo: true } });
  res.json({ commissions: holds, totalKobo: total._sum.amountKobo || 0 });
});

// ----------------------------------------------------------------- bookings

const getBooking = wrap(async (req, res) => {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      customer: { select: { id: true, name: true, phone: true, email: true } },
      artisan: { select: { id: true, category: true, user: { select: { id: true, name: true, phone: true } } } },
      escrowHolds: true,
      offers: true,
    },
  });
  if (!booking) return bad(res, "Booking not found.", 404);
  const [ratings, tickets] = await Promise.all([
    prisma.rating.findMany({ where: { bookingId: booking.id } }),
    prisma.supportTicket.findMany({ where: { bookingId: booking.id }, orderBy: { createdAt: "desc" } }),
  ]);
  res.json({ booking, ratings, tickets });
});

// ------------------------------------------------------------------ support

const replyTicket = wrap(async (req, res) => {
  const reply = String(req.body.reply || "").trim();
  if (!reply) return bad(res, "Write a reply first.");
  const status = req.body.status && ["OPEN", "IN_REVIEW", "RESOLVED"].includes(req.body.status) ? req.body.status : "IN_REVIEW";
  const ticket = await prisma.supportTicket.update({ where: { id: req.params.id }, data: { adminReply: reply.slice(0, 4000), repliedAt: new Date(), status } });
  await logAdminAction(req.user, "TICKET_REPLY", "SupportTicket", ticket.id, status);
  notify(req.app.get("io"), ticket.userId, "ADMIN", "FixMi support replied", reply.slice(0, 180), { ticketId: ticket.id }).catch(() => {});
  res.json({ ticket });
});

// --------------------------------------------------------------- moderation

const listRatings = wrap(async (req, res) => {
  const ratings = await prisma.rating.findMany({ orderBy: { createdAt: "desc" }, include: { rater: { select: { id: true, name: true } } }, ...pageOf(req) });
  res.json({ ratings });
});

// Hiding a rating removes it from the artisan's public reviews and average.
const hideRating = wrap(async (req, res) => {
  const hidden = req.body.hidden !== false;
  const rating = await prisma.rating.update({ where: { id: req.params.id }, data: { hidden } });
  if (rating.rateeRole === "ARTISAN") {
    const profile = await prisma.artisanProfile.findUnique({ where: { userId: rating.rateeUserId }, select: { id: true } });
    if (profile) {
      const agg = await prisma.rating.aggregate({ where: { rateeUserId: rating.rateeUserId, rateeRole: "ARTISAN", hidden: false }, _avg: { stars: true }, _count: { _all: true } });
      await prisma.artisanProfile.update({ where: { id: profile.id }, data: { ratingAvg: agg._avg.stars || 0, ratingCount: agg._count._all } });
    }
  }
  await logAdminAction(req.user, hidden ? "RATING_HIDDEN" : "RATING_RESTORED", "Rating", rating.id, null);
  res.json({ rating });
});

const listAppReviews = wrap(async (req, res) => {
  const reviews = await prisma.appReview.findMany({ orderBy: { createdAt: "desc" }, include: { user: { select: { id: true, name: true, role: true } } }, ...pageOf(req) });
  const agg = await prisma.appReview.aggregate({ where: { hidden: false }, _avg: { stars: true }, _count: { _all: true } });
  res.json({ reviews, average: agg._avg.stars || 0, count: agg._count._all });
});

const respondAppReview = wrap(async (req, res) => {
  const data = {};
  if (req.body.response !== undefined) {
    data.adminResponse = String(req.body.response).trim().slice(0, 1000) || null;
    data.respondedAt = data.adminResponse ? new Date() : null;
  }
  if (typeof req.body.hidden === "boolean") data.hidden = req.body.hidden;
  const review = await prisma.appReview.update({ where: { id: req.params.id }, data });
  await logAdminAction(req.user, "APP_REVIEW_UPDATED", "AppReview", review.id, null);
  res.json({ review });
});

// ----------------------------------------------------------------- settings

const listSettings = wrap(async (req, res) => res.json({ settings: await settings.listForAdmin() }));

const putSetting = wrap(async (req, res) => {
  await settings.set(req.params.key, req.body.value, req.user.id);
  await logAdminAction(req.user, "SETTING_UPDATED", "AppSetting", req.params.key, null);
  res.json({ ok: true });
});

const resetSetting = wrap(async (req, res) => {
  await settings.reset(req.params.key);
  await logAdminAction(req.user, "SETTING_RESET", "AppSetting", req.params.key, null);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- outreach

async function audience(roles) {
  const targetRoles = Array.isArray(roles) ? roles.filter((r) => ["CUSTOMER", "ARTISAN"].includes(r)) : [];
  return { targetRoles, where: { status: "ACTIVE", isGuest: false, role: { in: targetRoles.length ? targetRoles : ["CUSTOMER", "ARTISAN"] } } };
}

// Bulk SMS through Africa's Talking. Needs AFRICASTALKING_* variables.
const sendBulkSms = wrap(async (req, res) => {
  if (!sms.isConfigured()) return bad(res, "SMS is not configured yet. Add the Africa's Talking variables on the server.", 503);
  const body = String(req.body.body || "").trim();
  if (!body) return bad(res, "Write the message first.");
  if (body.length > 480) return bad(res, "Keep SMS under 480 characters.");
  const { targetRoles, where } = await audience(req.body.roles);
  const users = await prisma.user.findMany({ where: { ...where, phone: { not: null } }, select: { phone: true } });
  let failed = 0;
  for (const u of users) {
    try {
      await sms.sendSms(u.phone, body);
    } catch (e) {
      failed++;
    }
  }
  const record = await prisma.bulkMessage.create({ data: { channel: "SMS", body, targetRoles, recipientCount: users.length - failed, failedCount: failed, sentById: req.user.id, sentByName: req.user.name } });
  await logAdminAction(req.user, "BULK_SMS", "BulkMessage", record.id, `${users.length - failed} sent, ${failed} failed`);
  res.status(201).json({ message: record });
});

const listBulk = wrap(async (req, res) => res.json({ messages: await prisma.bulkMessage.findMany({ orderBy: { createdAt: "desc" }, take: 100 }) }));

// ------------------------------------------------------------ admin accounts

const listAdmins = wrap(async (req, res) => {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true, name: true, email: true, status: true, isSuperAdmin: true, createdAt: true, lastLoginAt: true }, orderBy: { createdAt: "asc" } });
  res.json({ admins });
});

const createAdmin = wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();
  const password = String(req.body.password || "");
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, "A name and a valid email are required.");
  if (password.length < 8) return bad(res, "The password needs at least 8 characters.");
  if (await prisma.user.findUnique({ where: { email } })) return bad(res, "That email already has an account.", 409);
  const admin = await prisma.user.create({
    data: { name, email, role: "ADMIN", status: "ACTIVE", passwordHash: await hashPassword(password), wallet: { create: {} }, notificationPref: { create: {} } },
    select: { id: true, name: true, email: true },
  });
  await logAdminAction(req.user, "ADMIN_CREATED", "User", admin.id, email);
  res.status(201).json({ admin });
});

const setAdminStatus = wrap(async (req, res) => {
  const status = req.body.status;
  if (!["ACTIVE", "SUSPENDED"].includes(status)) return bad(res, "status must be ACTIVE or SUSPENDED.");
  if (req.params.id === req.user.id) return bad(res, "You cannot change your own account.");
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || target.role !== "ADMIN") return bad(res, "Admin not found.", 404);
  if (target.isSuperAdmin) return bad(res, "A super admin cannot be suspended here.", 403);
  await prisma.user.update({ where: { id: target.id }, data: { status } });
  if (status === "SUSPENDED") await prisma.refreshToken.updateMany({ where: { userId: target.id }, data: { revoked: true } });
  await logAdminAction(req.user, status === "SUSPENDED" ? "ADMIN_SUSPENDED" : "ADMIN_REACTIVATED", "User", target.id, target.email);
  res.json({ ok: true });
});

// Demotes an admin to a normal customer account.
const removeAdmin = wrap(async (req, res) => {
  if (req.params.id === req.user.id) return bad(res, "You cannot remove yourself.");
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || target.role !== "ADMIN") return bad(res, "Admin not found.", 404);
  if (target.isSuperAdmin) return bad(res, "A super admin cannot be removed here.", 403);
  await prisma.user.update({ where: { id: target.id }, data: { role: "CUSTOMER" } });
  await prisma.refreshToken.updateMany({ where: { userId: target.id }, data: { revoked: true } });
  await logAdminAction(req.user, "ADMIN_REMOVED", "User", target.id, target.email);
  res.json({ ok: true });
});

module.exports = {
  dashboard, listUsers, getUser, setUserStatus, adjustWallet, deleteUser,
  listWithdrawals, payWithdrawal, rejectWithdrawal, listTransactions, listEscrow, listCommissions,
  getBooking, replyTicket, listRatings, hideRating, listAppReviews, respondAppReview,
  listSettings, putSetting, resetSetting, sendBulkSms, listBulk, listAdmins, createAdmin, setAdminStatus, removeAdmin,
};
