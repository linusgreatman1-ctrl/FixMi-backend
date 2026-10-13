const prisma = require("../config/db");

async function list(req, res, next) {
  try {
    const rows = await prisma.favourite.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      include: { artisan: { include: { user: { select: { name: true, avatarUrl: true, state: true } } } } },
    });
    res.json({ favourites: rows.map((f) => f.artisan) });
  } catch (err) {
    next(err);
  }
}

async function add(req, res, next) {
  try {
    const artisan = await prisma.artisanProfile.findUnique({ where: { id: req.params.artisanId }, select: { id: true } });
    if (!artisan) return res.status(404).json({ error: "Artisan not found." });
    await prisma.favourite.upsert({
      where: { userId_artisanId: { userId: req.user.id, artisanId: artisan.id } },
      update: {},
      create: { userId: req.user.id, artisanId: artisan.id },
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await prisma.favourite.deleteMany({ where: { userId: req.user.id, artisanId: req.params.artisanId } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, add, remove };
