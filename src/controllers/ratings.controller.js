const prisma = require("../config/db");

// One rating per booking, given by whichever side wasn't the ratee — a
// customer rates the artisan and vice versa, matching the frontend's
// post-job star-rating screen. rateeRole/rateeUserId are derived from the
// booking, never trusted from the client.
async function createRating(req, res, next) {
  try {
    const { bookingId, stars, comment } = req.body;
    if (!bookingId || !stars || stars < 1 || stars > 5) {
      return res.status(400).json({ error: "bookingId and a stars value 1-5 are required." });
    }

    const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { artisan: true } });
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (!["COMPLETED", "CONFIRMED"].includes(booking.status)) {
      return res.status(409).json({ error: "You can only rate a completed job." });
    }

    const isCustomer = booking.customerId === req.user.id;
    const isArtisan = req.user.artisanProfile && booking.artisanId === req.user.artisanProfile.id;
    if (isArtisan) return res.status(403).json({ error: "Only the customer rates a job. You can reply to their review from your Reviews." });
    if (!isCustomer) return res.status(403).json({ error: "Not your booking." });

    const rateeRole = isCustomer ? "ARTISAN" : "CUSTOMER";
    const rateeUserId = isCustomer ? booking.artisan.userId : booking.customerId;

    const rating = await prisma.$transaction(async (tx) => {
      const created = await tx.rating.create({
        data: { bookingId, raterId: req.user.id, rateeRole, rateeUserId, stars: Number(stars), comment: comment || null },
      });
      if (rateeRole === "ARTISAN") {
        const agg = await tx.rating.aggregate({ where: { rateeRole: "ARTISAN", rateeUserId, hidden: false }, _avg: { stars: true }, _count: true });
        await tx.artisanProfile.update({
          where: { id: booking.artisanId },
          data: { ratingAvg: agg._avg.stars || 0, ratingCount: agg._count },
        });
      }
      return created;
    });

    res.status(201).json({ rating });
  } catch (err) {
    next(err);
  }
}

// Reviews other people left about the signed-in user, for their profile.
async function myReviews(req, res, next) {
  try {
    const rows = await prisma.rating.findMany({
      where: { rateeUserId: req.user.id, hidden: false },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { rater: { select: { name: true } }, booking: { select: { category: true } } },
    });
    const count = rows.length;
    const average = count ? rows.reduce((n, r) => n + r.stars, 0) / count : 0;
    res.json({ average, count, reviews: rows.map((r) => ({ id: r.id, stars: r.stars, comment: r.comment, response: r.response, respondedAt: r.respondedAt, createdAt: r.createdAt, from: r.rater?.name?.split(" ")[0] || "User", category: r.booking?.category || null })) });
  } catch (err) {
    next(err);
  }
}

// The artisan answers a review left about them (shown under it on their public profile).
async function respondToReview(req, res, next) {
  try {
    const response = String(req.body?.response || "").trim().slice(0, 600);
    if (!response) return res.status(400).json({ error: "Write your reply first." });
    const rating = await prisma.rating.findUnique({ where: { id: req.params.id } });
    if (!rating || rating.rateeUserId !== req.user.id) return res.status(404).json({ error: "Review not found." });
    const updated = await prisma.rating.update({ where: { id: rating.id }, data: { response, respondedAt: new Date() } });
    res.json({ rating: updated });
  } catch (err) {
    next(err);
  }
}

module.exports = { createRating, myReviews, respondToReview };
