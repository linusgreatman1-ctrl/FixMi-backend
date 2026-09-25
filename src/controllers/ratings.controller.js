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
    if (!isCustomer && !isArtisan) return res.status(403).json({ error: "Not your booking." });

    const rateeRole = isCustomer ? "ARTISAN" : "CUSTOMER";
    const rateeUserId = isCustomer ? booking.artisan.userId : booking.customerId;

    const rating = await prisma.$transaction(async (tx) => {
      const created = await tx.rating.create({
        data: { bookingId, raterId: req.user.id, rateeRole, rateeUserId, stars: Number(stars), comment: comment || null },
      });
      if (rateeRole === "ARTISAN") {
        const agg = await tx.rating.aggregate({ where: { rateeRole: "ARTISAN", rateeUserId }, _avg: { stars: true }, _count: true });
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

module.exports = { createRating };
