const prisma = require("../config/db");
const { notifyAllAdmins } = require("../services/notifications.service");

// Public: what people say about FixMi (hidden reviews excluded).
async function listPublic(req, res, next) {
  try {
    const [reviews, agg] = await Promise.all([
      prisma.appReview.findMany({ where: { hidden: false, comment: { not: null } }, orderBy: { createdAt: "desc" }, take: 20, select: { stars: true, comment: true, adminResponse: true, createdAt: true, user: { select: { name: true, role: true } } } }),
      prisma.appReview.aggregate({ where: { hidden: false }, _avg: { stars: true }, _count: { _all: true } }),
    ]);
    const short = (n) => { const p = String(n || "").trim().split(/\s+/); return p[0] + (p[1] ? " " + p[1][0] + "." : ""); };
    res.json({ average: agg._avg.stars || 0, count: agg._count._all, reviews: reviews.map((r) => ({ ...r, user: { name: short(r.user.name), role: r.user.role } })) });
  } catch (err) {
    next(err);
  }
}

async function mine(req, res, next) {
  try {
    res.json({ review: await prisma.appReview.findUnique({ where: { userId: req.user.id } }) });
  } catch (err) {
    next(err);
  }
}

async function submit(req, res, next) {
  try {
    const stars = Number(req.body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: "Choose 1 to 5 stars." });
    const comment = req.body.comment ? String(req.body.comment).trim().slice(0, 1000) : null;
    const review = await prisma.appReview.upsert({
      where: { userId: req.user.id },
      update: { stars, comment },
      create: { userId: req.user.id, stars, comment },
    });
    notifyAllAdmins(req.app.get("io"), "⭐ New app review", `${req.user.name} rated FixMi ${stars}★${comment ? ": " + comment.slice(0, 80) : ""}`, { userId: req.user.id, kind: "APP_REVIEW" }).catch(() => {});
    res.status(201).json({ review });
  } catch (err) {
    next(err);
  }
}

module.exports = { listPublic, mine, submit };
