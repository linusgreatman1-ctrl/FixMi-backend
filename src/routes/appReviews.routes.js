const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/appReviews.controller");

const router = express.Router();
router.get("/", ctrl.listPublic);
router.get("/mine", requireAuth, ctrl.mine);
router.post("/", requireAuth, ctrl.submit);

module.exports = router;
