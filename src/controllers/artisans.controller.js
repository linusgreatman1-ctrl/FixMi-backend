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
    const { category, lat, lng, onlyAvailable } = req.query;
    const where = { kycStatus: "APPROVED", isVerified: true, user: { status: "ACTIVE" } };
    if (category) where.category = category;
    if (onlyAvailable === "true") where.isAvailable = true;

    const artisans = await prisma.artisanProfile.findMany({ where, select: PUBLIC_SELECT, orderBy: { ratingAvg: "desc" } });

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
    res.json({ artisan });
  } catch (err) {
    next(err);
  }
}

// Distinct category names currently offered, for the home screen's service
// grid to be data-driven instead of hardcoded.
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

module.exports = { listArtisans, getArtisan, listCategories };
