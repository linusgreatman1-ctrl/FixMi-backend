const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const ctrl = require("../controllers/chat.controller");

const router = express.Router();
router.use(requireAuth);
router.get("/threads", ctrl.listThreads);
router.get("/threads/:id/messages", ctrl.getMessages);
router.post("/support-thread", ctrl.openSupportThread);
router.post("/threads/:id/messages", ctrl.sendMessage);
router.post("/threads/:id/close", ctrl.closeThread);
router.post("/threads/:id/reopen", ctrl.reopenThread);
router.post("/threads/:id/attachment", upload.single("photo"), ctrl.uploadAttachment);

module.exports = router;
