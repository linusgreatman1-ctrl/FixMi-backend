const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

router.get("/stats", ctrl.stats);
router.get("/artisans/pending", ctrl.listPendingArtisans);
router.post("/artisans/:id/approve", ctrl.approveArtisan);
router.post("/artisans/:id/reject", ctrl.rejectArtisan);
router.get("/users", ctrl.listUsers);
router.post("/users/:id/suspend", ctrl.suspendUser);
router.post("/users/:id/reactivate", ctrl.reactivateUser);
router.get("/bookings", ctrl.listBookings);
router.get("/tickets", ctrl.listTickets);
router.patch("/tickets/:id", ctrl.updateTicket);

module.exports = router;
