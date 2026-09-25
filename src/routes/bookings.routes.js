const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/bookings.controller");

const router = express.Router();

router.use(requireAuth);
router.post("/", ctrl.createBooking);
router.get("/", ctrl.listMyBookings);
router.get("/open", ctrl.listOpenBookings);
router.get("/:id", ctrl.getBooking);
router.post("/:id/accept", ctrl.acceptBooking);
router.post("/:id/decline", ctrl.declineBooking);
router.post("/:id/pay", ctrl.payBooking);
router.post("/:id/start", ctrl.startBooking);
router.post("/:id/complete", ctrl.completeBooking);
router.post("/:id/confirm", ctrl.confirmBooking);
router.post("/:id/cancel", ctrl.cancelBooking);

module.exports = router;
