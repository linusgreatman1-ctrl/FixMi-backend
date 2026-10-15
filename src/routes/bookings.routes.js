const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/bookings.controller");

const router = express.Router();

router.use(requireAuth);
router.post("/", ctrl.createBooking);
router.get("/", ctrl.listMyBookings);
router.get("/open", ctrl.listOpenBookings);
router.get("/active", ctrl.getActiveBooking);
router.get("/:id", ctrl.getBooking);
// Artisan: accept / price / hold / decline an open request
router.post("/:id/respond", ctrl.artisanRespond);
// Customer: accept / counter / reject one artisan's offer
router.post("/:id/offers/:offerId", ctrl.customerRespond);
router.post("/:id/cancel", ctrl.cancelBooking);
router.post("/:id/arrive", ctrl.arriveBooking);
router.post("/:id/onsite-price", ctrl.submitOnsitePrice);
router.post("/:id/onsite-respond", ctrl.respondOnsitePrice);
router.post("/:id/start", ctrl.startBooking);
router.post("/:id/complete", ctrl.completeBooking);
router.post("/:id/confirm", ctrl.confirmBooking);
// "Job not completed": customer freezes the escrow; artisan adds their side
router.post("/:id/dispute", ctrl.openDispute);
router.get("/:id/dispute", ctrl.getDispute);
router.post("/:id/dispute/respond", ctrl.respondDispute);
router.post("/:id/dispute/chat", ctrl.openDisputeChat);

module.exports = router;
