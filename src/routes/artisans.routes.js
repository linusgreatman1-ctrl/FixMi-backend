const express = require("express");
const ctrl = require("../controllers/artisans.controller");

const router = express.Router();

router.get("/", ctrl.listArtisans);
router.get("/categories", ctrl.listCategories);
router.get("/:id", ctrl.getArtisan);

module.exports = router;
