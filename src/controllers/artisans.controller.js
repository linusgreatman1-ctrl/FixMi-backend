const prisma = require("../config/db");

const PUBLIC_SELECT = {
  id: true,
  category: true,
  bizName: true,
  bio: true,
  yearsExp: true,
  isVerified: true,
  isAvailable: true,
  lat: true,
  lng: true,
  ratingAvg: true,
  ratingCount: true,
  jobsDone: true,
  user: { select: { id: true, name: true, avatarUrl: true, state: true, lga: true } },
};

// Haversine distance in km — used to sort/filter "nearby" artisans when the
// customer's lat/lng is known. Cheap enough at this scale to do in JS
// rather than a PostGIS extension.
function distanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined)) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function listArtisans(req, res, next) {
  try {
    const { category, lat, lng, onlyAvailable, featured } = req.query;
    const where = { kycStatus: "APPROVED", isVerified: true, user: { status: "ACTIVE" } };
    if (category) where.category = category;
    if (onlyAvailable === "true") where.isAvailable = true;
    // Homepage list: only artisans with a paid, unexpired promotion (up to
    // 20 — the page shows 10 on phones, 15 on tablets, 20 on desktop).
    if (featured === "true") where.featuredUntil = { gt: new Date() };

    const artisans = await prisma.artisanProfile.findMany({
      where,
      select: PUBLIC_SELECT,
      orderBy: { ratingAvg: "desc" },
      ...(featured === "true" ? { take: 25 } : {}),
    });

    const withDistance = artisans.map((a) => ({
      ...a,
      distanceKm: lat && lng ? distanceKm(Number(lat), Number(lng), a.lat, a.lng) : null,
    }));
    if (lat && lng) withDistance.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));

    res.json({ artisans: withDistance });
  } catch (err) {
    next(err);
  }
}

async function getArtisan(req, res, next) {
  try {
    const artisan = await prisma.artisanProfile.findUnique({ where: { id: req.params.id }, select: PUBLIC_SELECT });
    if (!artisan) return res.status(404).json({ error: "Artisan not found." });
    const reviews = await prisma.rating.findMany({
      where: { rateeUserId: artisan.user.id, rateeRole: "ARTISAN", hidden: false },
      select: { stars: true, comment: true, createdAt: true, rater: { select: { name: true } }, booking: { select: { category: true } } },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    // Reviewers are shown by first name and initial only.
    const shortName = (n) => { const p = String(n || "").trim().split(/\s+/); return p[0] + (p[1] ? " " + p[1][0] + "." : ""); };
    res.json({ artisan: { ...artisan, reviews: reviews.map((r) => ({ stars: r.stars, comment: r.comment, createdAt: r.createdAt, category: r.booking.category, by: shortName(r.rater.name) })) } });
  } catch (err) {
    next(err);
  }
}

// Distinct category names currently offered, for the home screen's service
// grid to be data-driven instead of hardcoded.
// Live numbers for the home screen: verified artisans, how many are online,
// their average rating, and how long artisans actually take to arrive.
async function publicStats(req, res, next) {
  try {
    const verified = { isVerified: true, kycStatus: "APPROVED", user: { status: "ACTIVE" } };
    const [artisans, online, rated, arrival] = await Promise.all([
      prisma.artisanProfile.count({ where: verified }),
      prisma.artisanProfile.count({ where: { ...verified, isAvailable: true } }),
      prisma.artisanProfile.findMany({ where: { ...verified, ratingCount: { gt: 0 } }, select: { ratingAvg: true, ratingCount: true } }),
      prisma.$queryRaw`SELECT AVG(EXTRACT(EPOCH FROM ("arrivedAt" - "acceptedAt")) / 60)::float AS minutes, COUNT(*)::int AS n
        FROM "Booking" WHERE "arrivedAt" IS NOT NULL AND "acceptedAt" IS NOT NULL
        AND "arrivedAt" > "acceptedAt" AND "arrivedAt" - "acceptedAt" < interval '6 hours'`,
    ]);
    const votes = rated.reduce((n, a) => n + a.ratingCount, 0);
    const avgRating = votes ? rated.reduce((n, a) => n + a.ratingAvg * a.ratingCount, 0) / votes : null;
    const row = arrival[0] || {};
    res.json({
      artisans,
      online,
      avgRating: avgRating == null ? null : Math.round(avgRating * 10) / 10,
      avgArrivalMinutes: row.n ? Math.max(1, Math.round(row.minutes)) : null,
    });
  } catch (err) {
    next(err);
  }
}

async function listCategories(req, res, next) {
  try {
    const rows = await prisma.artisanProfile.findMany({
      where: { kycStatus: "APPROVED", isVerified: true },
      select: { category: true },
      distinct: ["category"],
    });
    res.json({ categories: rows.map((r) => r.category) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  publicStats, listArtisans, getArtisan, listCategories };
