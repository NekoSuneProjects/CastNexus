"use strict";

// Discord Activity watch page: one channel, chosen by the host owner.
//
// A Discord Activity is a web page Discord loads in an iframe inside a voice
// channel (https://<client id>.discordsays.com). Discord proxies every request
// through its own domain using the app's URL Mappings, so the page only ever
// uses RELATIVE URLs. The expected mapping is a single root mapping:
//
//     PREFIX  /        TARGET  castnexus.example.com/activity
//
// The Activity never lists or plays anybody else's stream. It plays exactly
// one CastNexus channel:
//   1. DISCORD_ACTIVITY_CHANNEL in .env (locks the choice), else
//   2. the channel the host owner picked in Studio -> Settings -> Discord Activity, else
//   3. the host owner's own channel.
//
// Routes under /activity:
//   /                         the watch page
//   /activity-app.js|.css     page script / stylesheet
//   /sdk/*.mjs                @discord/embedded-app-sdk (from node_modules)
//   /hls.min.js               hls.js (from node_modules)
//   /api/config               client id, title, transport options
//   /api/channel              the selected channel and whether it is live
//   /hls/public/<login>/...   LL-HLS from MediaMTX - selected channel only
//   /webrtc/public/<login>/whep  WebRTC/WHEP from MediaMTX - selected channel only
//
// Any source works (console via the VPS gateway, PC/OBS, Music 24/7, VOD
// rerun) because the page plays the same public/<login> program as the other
// playback links.

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const ACTIVITY_DIR = path.join(__dirname, "activity");

function resolvePackagePath(name, subpath) {
  try {
    return path.join(path.dirname(require.resolve(`${name}/package.json`)), subpath);
  } catch {
    return null;
  }
}

function normaliseLogin(value) { return String(value || "").trim().toLowerCase(); }

function activityConfig(env = process.env) {
  const clientId = String(env.DISCORD_CLIENT_ID || "").trim();
  const valid = /^\d{15,25}$/.test(clientId);
  return {
    clientId:valid ? clientId : "",
    clientIdInvalid:!!clientId && !valid,
    lockedChannel:normaliseLogin(env.DISCORD_ACTIVITY_CHANNEL),
    title:String(env.DISCORD_ACTIVITY_TITLE || "CastNexus Live").trim().slice(0, 80) || "CastNexus Live",
    webrtc:String(env.DISCORD_ACTIVITY_WEBRTC ?? "true").trim().toLowerCase() !== "false",
  };
}

// Which login the Activity plays. `logins` = accounts on this install.
function selectedChannelLogin({ lockedChannel = "", savedChannel = "", ownerLogin = "", logins = [] } = {}) {
  const known = new Set(logins.map(normaliseLogin));
  if (lockedChannel) return normaliseLogin(lockedChannel);
  const saved = normaliseLogin(savedChannel);
  if (saved && known.has(saved)) return saved;
  const owner = normaliseLogin(ownerLogin);
  return owner || null;
}

// "/public/<login>/index.m3u8" is allowed only for the selected channel.
function streamPathAllowed(reqPath, selectedLogin) {
  if (!selectedLogin) return false;
  const match = String(reqPath || "").match(/^\/public\/([^/]+)(?:\/|$)/);
  if (!match) return false;
  try { return decodeURIComponent(match[1]).toLowerCase() === selectedLogin; } catch { return false; }
}

function publicChannel(row) {
  if (!row) return null;
  return {
    login:normaliseLogin(row.login),
    displayName:String(row.displayName || row.login),
    profileImageUrl:/^https:\/\//i.test(String(row.profileImageUrl || "")) ? row.profileImageUrl : null,
    live:!!row.source,
    source:row.source || null,
  };
}

function createDiscordActivityRouter({
  getChannel,
  env = process.env,
  hlsTarget = process.env.MEDIAMTX_HLS_ORIGIN || "http://127.0.0.1:8888",
  webrtcTarget = process.env.MEDIAMTX_WEBRTC_ORIGIN || "http://127.0.0.1:8889",
} = {}) {
  if (typeof getChannel !== "function") throw new Error("getChannel is required");
  const config = activityConfig(env);
  const router = express.Router();
  const sdkDir = resolvePackagePath("@discord/embedded-app-sdk", "output");
  const hlsFile = resolvePackagePath("hls.js", path.join("dist", "hls.min.js"));

  if (config.clientIdInvalid) console.warn("[discord-activity] DISCORD_CLIENT_ID must be the numeric Application ID from the Discord Developer Portal - ignoring it");
  else if (!config.clientId) console.warn("[discord-activity] DISCORD_CLIENT_ID is not set - the page works in a browser but Discord will not load it as an Activity");
  if (!sdkDir || !fs.existsSync(sdkDir)) console.warn("[discord-activity] @discord/embedded-app-sdk is not installed - run npm install in the dashboard folder");
  console.log(`[discord-activity] watch page enabled at /activity (${config.lockedChannel ? `locked to ${config.lockedChannel} by DISCORD_ACTIVITY_CHANNEL` : "channel chosen by the host owner in Settings"})`);

  // Deliberately no X-Frame-Options: Discord embeds this page in its client.
  router.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const sendPage = (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.sendFile(path.join(ACTIVITY_DIR, "index.html")); };
  router.get("/", sendPage);
  router.get("/index.html", sendPage);
  router.get("/activity-app.js", (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.type("application/javascript").sendFile(path.join(ACTIVITY_DIR, "activity-app.js")); });
  router.get("/activity-app.css", (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.type("text/css").sendFile(path.join(ACTIVITY_DIR, "activity-app.css")); });

  if (sdkDir) {
    router.use("/sdk", express.static(sdkDir, {
      index:false,
      maxAge:"1d",
      setHeaders:(res, file) => { if (file.endsWith(".mjs")) res.setHeader("Content-Type", "application/javascript; charset=utf-8"); },
    }));
  }
  if (hlsFile) router.get("/hls.min.js", (_req, res) => { res.setHeader("Cache-Control", "public, max-age=86400"); res.type("application/javascript").sendFile(hlsFile); });

  router.get("/api/config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ clientId:config.clientId || null, title:config.title, webrtc:config.webrtc, sdk:!!sdkDir, hls:!!hlsFile });
  });
  router.get("/api/channel", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ channel:publicChannel(getChannel()) });
  });

  const guard = (req, res, next) => {
    const channel = getChannel();
    if (streamPathAllowed(req.path, channel?.login ? normaliseLogin(channel.login) : null)) return next();
    res.status(404).type("text/plain").send("not found");
  };
  router.use("/hls", guard, createProxyMiddleware({ target:hlsTarget, changeOrigin:true, pathRewrite:{ "^/activity/hls":"" }, logLevel:"warn" }));
  router.use("/webrtc", guard, createProxyMiddleware({ target:webrtcTarget, changeOrigin:true, pathRewrite:{ "^/activity/webrtc":"" }, logLevel:"warn" }));

  router.use((_req, res) => res.status(404).type("text/plain").send("not found"));
  return router;
}

module.exports = {
  createDiscordActivityRouter,
  activityConfig,
  selectedChannelLogin,
  streamPathAllowed,
  publicChannel,
  normaliseLogin,
};
