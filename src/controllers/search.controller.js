const prisma = require("../config/db");

async function search(req, res, next) {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ artisans: [] });

    const artisans = await prisma.artisanProfile.findMany({
      where: {
        kycStatus: "APPROVED",
        isVerified: true,
        OR: [
          { category: { contains: q, mode: "insensitive" } },
          { bizName: { contains: q, mode: "insensitive" } },
          { user: { name: { contains: q, mode: "insensitive" } } },
        ],
      },
      select: {
        id: true,
        category: true,
        bizName: true,
        ratingAvg: true,
        ratingCount: true,
        isAvailable: true,
        user: { select: { name: true, avatarUrl: true } },
      },
      take: 30,
    });

    res.json({ artisans });
  } catch (err) {
    next(err);
  }
}

module.exports = { search };
