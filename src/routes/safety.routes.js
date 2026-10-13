const express = require("express");
const rateLimit = require("express-rate-limit");
const { requireAuth } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const ctrl = require("../controllers/safety.controller");

const router = express.Router();
router.use(requireAuth);
router.get("/", ctrl.overview);
router.post("/documents", upload.single("file"), ctrl.uploadDocument);
router.delete("/documents/:id", ctrl.deleteDocument);
router.get("/contacts", ctrl.listContacts);
router.post("/contacts", ctrl.addContact);
router.delete("/contacts/:id", ctrl.deleteContact);
router.get("/reports", ctrl.listMyReports);
router.post("/reports", rateLimit({ windowMs: 60 * 1000, max: 10 }), ctrl.createReport);

module.exports = router;
