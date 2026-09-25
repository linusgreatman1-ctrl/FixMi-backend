const express = require("express");
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/chat.controller");

const router = express.Router();
router.use(requireAuth);
router.get("/threads", ctrl.listThreads);
router.get("/threads/:id/messages", ctrl.getMessages);
router.post("/threads/:id/messages", ctrl.sendMessage);

module.exports = router;
