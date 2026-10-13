const fs = require("fs");
const path = require("path");

// Where uploaded images (avatars, dispute evidence) are stored. On Railway,
// point UPLOAD_DIR at a mounted volume (e.g. /data/uploads) so files survive
// redeploys; locally it falls back to ./uploads.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "..", "uploads");
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (err) {
  console.error("[uploads] could not create", UPLOAD_DIR, err.message);
}

module.exports = { UPLOAD_DIR };
