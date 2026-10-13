const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/corporate.controller");

const router = express.Router();
router.use(requireAuth);
router.get("/", ctrl.getCorporate);
router.post("/plan", ctrl.subscribe);
router.post("/topup", ctrl.topUp);
router.post("/cancel", ctrl.cancelPlan);

module.exports = router;
