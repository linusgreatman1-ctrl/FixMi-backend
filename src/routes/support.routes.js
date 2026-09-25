const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/support.controller");

const router = express.Router();
router.use(requireAuth);
router.post("/tickets", ctrl.createTicket);
router.get("/tickets", ctrl.listMyTickets);

module.exports = router;
