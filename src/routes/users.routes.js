const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const ctrl = require("../controllers/users.controller");

const router = express.Router();

router.use(requireAuth);
router.patch("/me", ctrl.updateMe);
router.patch("/me/artisan-profile", ctrl.updateArtisanProfile);
router.patch("/me/availability", ctrl.setAvailability);
router.post("/me/avatar", upload.single("avatar"), ctrl.uploadAvatar);
router.post("/me/bank-account", ctrl.linkBankAccount);
router.get("/banks", ctrl.listBanks);

module.exports = router;
