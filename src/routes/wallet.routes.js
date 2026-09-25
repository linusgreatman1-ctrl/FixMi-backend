const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/wallet.controller");

const router = express.Router();

router.use(requireAuth);
router.get("/", ctrl.getWallet);
router.get("/transactions", ctrl.listTransactions);
router.post("/withdraw", ctrl.withdraw);
router.get("/withdrawals", ctrl.listWithdrawals);

module.exports = router;
