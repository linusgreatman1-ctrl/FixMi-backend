const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/payments.controller");

const router = express.Router();

// Webhook must be mounted WITHOUT requireAuth — Paystack calls it directly,
// and its own HMAC signature check is the authentication.
router.post("/webhook", ctrl.webhook);

router.use(requireAuth);
router.post("/wallet-deposit", ctrl.initializeWalletDeposit);
router.post("/wallet-deposit/dev", ctrl.devTopUp);
router.get("/verify/:reference", ctrl.verifyPayment);

module.exports = router;
