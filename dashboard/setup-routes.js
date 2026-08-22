"use strict";

const express = require("express");
const router = express.Router();

function isSetupComplete(req) {
  return req.session?.accountId || false;
}

router.get("/", (req, res) => {
  if (isSetupComplete(req)) {
    return res.redirect("/");
  }
  res.sendFile(__dirname + "/public/setup.html");
});

router.get("/api/setup/status", (req, res) => {
  res.json({
    setupComplete: isSetupComplete(req),
    sessionAccountId: req.session?.accountId || null,
  });
});

router.post("/api/setup/oauth/twitch", (req, res) => {
  const { clientId, clientSecret, redirectUri } = req.body;

  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(400).json({ error: "Missing required OAuth parameters" });
  }

  req.session.setupData = {
    twitchClientId: clientId,
    twitchClientSecret: clientSecret,
    twitchRedirectUri: redirectUri,
  };

  res.json({ success: true });
});

router.post("/api/setup/rtmp-key", (req, res) => {
  const { rtmpKey, rtmpUrl } = req.body;

  if (!rtmpKey) {
    return res.status(400).json({ error: "RTMP key is required" });
  }

  req.session.setupData = req.session.setupData || {};
  req.session.setupData.rtmpKey = rtmpKey;
  req.session.setupData.rtmpUrl = rtmpUrl || "rtmp://127.0.0.1:1935";

  res.json({ success: true });
});

router.post("/api/setup/complete", (req, res) => {
  const setupData = req.session.setupData || {};

  if (!setupData.twitchClientId) {
    return res.status(400).json({ error: "Setup not completed: missing Twitch OAuth" });
  }

  req.session.setupComplete = true;

  res.json({
    success: true,
    message: "Setup complete! Redirecting to dashboard...",
  });
});

module.exports = router;
