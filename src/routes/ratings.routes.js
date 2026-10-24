const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/ratings.controller");

const router = express.Router();
router.use(requireAuth);
router.post("/", ctrl.createRating);
router.get("/mine", ctrl.myReviews);
router.post("/:id/respond", ctrl.respondToReview);

module.exports = router;
