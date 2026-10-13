const express = require("express");

const { commissionPercent } = require("../config/money");
const { autoReleaseMinutes } = require("../services/escrow.service");

const router = express.Router();

// Public — ICE server info (including TURN credentials, if configured) is
// meant to be handed to WebRTC clients directly. Letting this live in env
// vars means a TURN server can be added later without a frontend redeploy.
router.get("/ice-servers", (req, res) => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

// Numbers the app shows to people: the platform's cut and how long a
// customer has to confirm before escrow releases on its own.
router.get("/app", (req, res) => {
  res.json({ commissionPercent: commissionPercent(), autoReleaseMinutes: autoReleaseMinutes() });
});

module.exports = router;
