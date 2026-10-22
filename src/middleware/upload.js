const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const prisma = require("../config/db");
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

const diskUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed."));
    }
    cb(null, true);
  },
});

// After a photo is saved to disk, keep a copy in the database too (see StoredFile).
function keepCopy(req, res, next) {
  const file = req.file;
  if (!file) return next();
  fs.promises.readFile(file.path)
    .then((data) => prisma.storedFile.upsert({ where: { name: file.filename }, create: { name: file.filename, mime: file.mimetype, data }, update: {} }))
    .then(() => next(), () => next()); // the disk copy is still there; a failed backup must not fail the upload
}

// Same as multer's upload.single(field), plus the database copy.
const upload = { single: (field) => [diskUpload.single(field), keepCopy] };

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
