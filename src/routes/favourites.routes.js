const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/favourites.controller");

const router = express.Router();
router.use(requireAuth);
router.get("/", ctrl.list);
router.post("/:artisanId", ctrl.add);
router.delete("/:artisanId", ctrl.remove);

module.exports = router;
