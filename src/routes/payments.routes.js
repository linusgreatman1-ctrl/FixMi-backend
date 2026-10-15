const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/payments.controller");
const manual = require("../controllers/manualPayments.controller");

const router = express.Router();

// Webhook must be mounted WITHOUT requireAuth — Paystack calls it directly,
// and its own HMAC signature check is the authentication.
router.post("/webhook", ctrl.webhook);
// Money arriving in the company account: confirms the matching bank-transfer request by itself.
router.post("/webhook/bank-credit", ctrl.bankCreditWebhook);

router.use(requireAuth);
router.get("/methods", ctrl.methods);
router.post("/checkout", ctrl.checkout);
router.post("/wallet-deposit", ctrl.initializeWalletDeposit);
router.post("/wallet-deposit/dev", ctrl.devTopUp);
router.get("/verify/:reference", ctrl.verifyPayment);
router.get("/manual/info", manual.info);
router.get("/manual/:id", ctrl.getManual);
router.post("/manual/:id/dev-confirm", ctrl.devConfirmManual);
router.get("/manual", manual.listMine);
router.post("/manual", manual.create);

module.exports = router;
