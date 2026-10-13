const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/settings.controller");

const router = express.Router();
router.use(requireAuth);
router.get("/", ctrl.getSettings);
router.patch("/notifications", ctrl.updateNotificationPrefs);
router.get("/addresses", ctrl.listAddresses);
router.post("/addresses", ctrl.addAddress);
router.patch("/addresses/:id", ctrl.updateAddress);
router.delete("/addresses/:id", ctrl.deleteAddress);
router.post("/deactivate", ctrl.deactivateAccount);

module.exports = router;
