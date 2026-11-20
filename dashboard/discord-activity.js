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
  const login = normaliseLogin(row.login);
  return {
    login,
    displayName:String(row.displayName || row.login),
    // Discord's Activity sandbox blocks images from other hosts, so avatars
    // are served through this server (see /api/avatar/:login).
    profileImageUrl:/^https:\/\//i.test(String(row.profileImageUrl || "")) ? `api/avatar/${encodeURIComponent(login)}` : null,
    live:!!row.source,
    source:row.source || null,
  };
}

// Only Twitch's image CDN is fetched for avatars.
const AVATAR_HOSTS = /^(static-cdn\.jtvnw\.net)$/i;
function avatarSourceAllowed(url) {
  try { const u = new URL(url); return u.protocol === "https:" && AVATAR_HOSTS.test(u.hostname); } catch { return false; }
}

function createDiscordActivityRouter({
  getChannel,
  // Optional, for voice-channel auto-detect (see discord-link.js):
  getMode = () => "fixed",            // "auto" | "fixed"
  discordApi = null,                  // createDiscordApi(); null = auto-detect off
  liveLinked = () => [],              // (discordUserIds) -> channel rows
  streamAllowed = null,               // (login) -> bool; default: selected channel only
  avatarUrlFor = () => null,          // (login) -> Twitch avatar URL
  fetchImpl = (...args) => global.fetch(...args),
  env = process.env,
  hlsTarget = process.env.MEDIAMTX_HLS_ORIGIN || "http://127.0.0.1:8888",
  webrtcTarget = process.env.MEDIAMTX_WEBRTC_ORIGIN || "http://127.0.0.1:8889",
} = {}) {
  if (typeof getChannel !== "function") throw new Error("getChannel is required");
  const config = activityConfig(env);
  const router = express.Router();
  const sdkDir = resolvePackagePath("@discord/embedded-app-sdk", "output");
  const hlsFile = resolvePackagePath("hls.js", path.join("dist", "hls.min.js"));
  const autoDetect = () => !!discordApi && getMode() === "auto";

  if (config.clientIdInvalid) console.warn("[discord-activity] DISCORD_CLIENT_ID must be the numeric Application ID from the Discord Developer Portal - ignoring it");
  else if (!config.clientId) console.warn("[discord-activity] DISCORD_CLIENT_ID is not set - the page works in a browser but Discord will not load it as an Activity");
  if (!sdkDir || !fs.existsSync(sdkDir)) console.warn("[discord-activity] @discord/embedded-app-sdk is not installed - run npm install in the dashboard folder");
  if (!discordApi) console.log("[discord-activity] DISCORD_CLIENT_SECRET is not set - voice-channel auto-detect and Discord account linking are off");
  console.log(`[discord-activity] watch page enabled at /activity (${config.lockedChannel ? `locked to ${config.lockedChannel} by DISCORD_ACTIVITY_CHANNEL` : discordApi ? "auto-detects live linked streamers in the voice channel, else the owner's channel" : "channel chosen by the host owner in Settings"})`);

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
    res.json({ clientId:config.clientId || null, title:config.title, webrtc:config.webrtc, sdk:!!sdkDir, hls:!!hlsFile, autoDetect:autoDetect() });
  });
  router.get("/api/channel", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ channel:publicChannel(getChannel()) });
  });

  // --- voice-channel auto-detect --------------------------------------------
  const json = express.json({ limit:"16kb" });
  // Exchanges the Embedded App SDK authorize() code for an access token the
  // Activity passes to authenticate(). The token is not stored.
  router.post("/api/token", json, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!autoDetect()) return res.status(404).json({ error:"auto-detect is off" });
    try {
      const token = await discordApi.exchangeCode(req.body?.code);
      res.json({ access_token:token.access_token, expires_in:token.expires_in, scope:token.scope });
    } catch (err) { res.status(err.status || 400).json({ error:err.message }); }
  });
  // Which of these Discord users (the voice channel's members) are linked to a
  // CastNexus account that is live right now. Requires the viewer's own token.
  router.post("/api/voice-live", json, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!autoDetect()) return res.json({ channels:[] });
    try {
      await discordApi.viewerFor(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
      const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.map(String).filter(id => /^\d{15,25}$/.test(id)).slice(0, 100) : [];
      res.json({ channels:liveLinked(ids).map(row => ({ ...publicChannel(row), discordId:String(row.discordId || "") })) });
    } catch (err) { res.status(err.status || 400).json({ error:err.message, channels:[] }); }
  });

  // --- avatars ------------------------------------------------------------------
  const avatarCache = new Map();
  router.get("/api/avatar/:login", async (req, res) => {
    const login = normaliseLogin(req.params.login);
    const source = avatarUrlFor(login);
    if (!source || !avatarSourceAllowed(source)) return res.status(404).end();
    try {
      let hit = avatarCache.get(source);
      if (!hit || hit.until < Date.now()) {
        const upstream = await fetchImpl(source);
        const type = String(upstream.headers.get("content-type") || "");
        if (!upstream.ok || !/^image\//i.test(type)) return res.status(404).end();
        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.length > 2 * 1024 * 1024) return res.status(404).end();
        hit = { type, body, until:Date.now() + 6 * 60 * 60 * 1000 };
        avatarCache.set(source, hit);
        if (avatarCache.size > 200) avatarCache.delete(avatarCache.keys().next().value);
      }
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.type(hit.type).send(hit.body);
    } catch { res.status(404).end(); }
  });

  // --- stream proxy -----------------------------------------------------------
  const allowed = login => {
    if (typeof streamAllowed === "function") return streamAllowed(login);
    const channel = getChannel();
    return !!channel?.login && normaliseLogin(channel.login) === login;
  };
  const guard = (req, res, next) => {
    const match = String(req.path || "").match(/^\/public\/([^/]+)(?:\/|$)/);
    let login = null;
    if (match) { try { login = decodeURIComponent(match[1]).toLowerCase(); } catch {} }
    if (login && streamPathAllowed(req.path, login) && allowed(login)) return next();
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
  avatarSourceAllowed,
  normaliseLogin,
};
