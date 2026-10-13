const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");
const bookings = require("../controllers/bookings.controller");
const safety = require("../controllers/safety.controller");
const tools = require("../controllers/adminTools.controller");
const { requireSuperAdmin } = require("../middleware/auth");

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
router.get("/disputes", bookings.listDisputes);
router.post("/disputes/:ticketId/resolve", bookings.resolveDispute);
router.get("/kyc/documents", safety.adminListDocuments);
router.post("/kyc/documents/:id/review", safety.adminReviewDocument);
router.get("/safety/reports", safety.adminListReports);
router.patch("/safety/reports/:id", safety.adminUpdateReport);
router.get("/announcements", tools.listAnnouncements);
router.post("/announcements", requireSuperAdmin, tools.sendAnnouncement);
router.get("/audit-log", requireSuperAdmin, tools.listAuditLog);

module.exports = router;
