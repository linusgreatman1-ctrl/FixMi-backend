const crypto = require("crypto");

// Human-shareable transaction/booking reference, e.g. FXM-9F3A2B1C.
function generateReference(prefix = "FXM") {
  return `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

module.exports = { generateReference };
