const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/support.controller");
const { upload } = require("../middleware/upload");

const router = express.Router();
router.use(requireAuth);
router.post("/tickets", ctrl.createTicket);
router.get("/tickets", ctrl.listMyTickets);
router.post("/evidence", upload.single("photo"), ctrl.uploadEvidence);

module.exports = router;
