const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { UPLOAD_DIR } = require("../config/paths");

// Local disk storage for dev/small deployments. Swap the storage engine
// for an S3/Cloudinary one in production — every controller here only
// reads req.file.filename / builds a URL from it, so that's the only
// thing that would need to change.
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed."));
    }
    cb(null, true);
  },
});

// Same limits, but keeps the file in memory so it can be stored in the database
// (used for ID documents, which must not sit in the public /uploads folder).
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed."));
    cb(null, true);
  },
});

module.exports = { upload, uploadMemory };
