const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/ratings.controller");

const router = express.Router();
router.use(requireAuth);
router.post("/", ctrl.createRating);

module.exports = router;
