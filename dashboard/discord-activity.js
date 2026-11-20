"use strict";

// Discord Activity watch page.
//
// A Discord Activity is a web page Discord loads in an iframe inside a voice
// channel (https://<client id>.discordsays.com). Discord proxies every request
// through its own domain using the app's URL Mappings, so this page must only
// ever use RELATIVE URLs. The expected mapping is a single root mapping:
//
//     PREFIX  /        TARGET  castnexus.example.com/activity
//
// Everything the page needs therefore lives under /activity on this server:
//
//   /activity/                  the watch page (channel picker + player)
//   /activity/activity-app.js   page script / stylesheet
//   /activity/sdk/*.mjs         @discord/embedded-app-sdk (served from node_modules)
//   /activity/hls.min.js        hls.js (served from node_modules)
//   /activity/api/config        public client id / title / default channel
//   /activity/api/channels      which CastNexus channels can be watched
//   /activity/hls/public/<login>/...     LL-HLS from MediaMTX (allowed channels only)
//   /activity/webrtc/public/<login>/whep WebRTC/WHEP from MediaMTX (allowed channels only)
//
// Any source works - console (PS5/Xbox/Switch via the VPS gateway), PC/OBS,
// Music 24/7 or a VOD rerun - because the page plays the same public/<login>
// program the other playback links use. Nobody has to screen-share.

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const ACTIVITY_DIR = path.join(__dirname, "activity");

function resolvePackageDir(name, subdir) {
  try {
    return path.join(path.dirname(require.resolve(`${name}/package.json`)), subdir);
  } catch {
    return null;
  }
}

function parseLoginList(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "*") return null; // null = every account on this install
  const list = raw.split(/[\s,]+/).map(v => v.trim().toLowerCase()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

function activityConfig(env = process.env) {
  const clientId = String(env.DISCORD_CLIENT_ID || "").trim();
  return {
    clientId:/^\d{15,25}$/.test(clientId) ? clientId : "",
    clientIdInvalid:!!clientId && !/^\d{15,25}$/.test(clientId),
    allowed:parseLoginList(env.DISCORD_ACTIVITY_CHANNELS),
    defaultChannel:String(env.DISCORD_ACTIVITY_DEFAULT_CHANNEL || "").trim().toLowerCase(),
    title:String(env.DISCORD_ACTIVITY_TITLE || "CastNexus Live").trim().slice(0, 80) || "CastNexus Live",
    webrtc:String(env.DISCORD_ACTIVITY_WEBRTC ?? "true").trim().toLowerCase() !== "false",
  };
}

// Channel rows the page may see. With no explicit allow-list only channels
// that are live right now are listed, so an idle multi-user install does not
// advertise every account it hosts.
function visibleChannels(rows, config) {
  const out = [];
  for (const row of rows || []) {
    const login = String(row?.login || "").toLowerCase();
    if (!login) continue;
    const live = !!row.source;
    if (config.allowed ? !config.allowed.has(login) : !live) continue;
    out.push({
      login,
      displayName:String(row.displayName || login),
      profileImageUrl:/^https:\/\//i.test(String(row.profileImageUrl || "")) ? row.profileImageUrl : null,
      live,
      source:live ? row.source : null,
    });
  }
  out.sort((a, b) => (Number(b.live) - Number(a.live)) || a.displayName.localeCompare(b.displayName));
  return out;
}

// "/public/<login>/index.m3u8" -> "<login>" when that channel may be watched.
function allowedStreamLogin(reqPath, rows, config) {
  const match = String(reqPath || "").match(/^\/public\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  let login;
  try { login = decodeURIComponent(match[1]).toLowerCase(); } catch { return null; }
  const known = (rows || []).some(row => String(row?.login || "").toLowerCase() === login);
  if (!known) return null;
  if (config.allowed && !config.allowed.has(login)) return null;
  return login;
}

function activityHeaders(res) {
  // Deliberately no X-Frame-Options: Discord embeds this page in its client.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function createDiscordActivityRouter({
  listChannels,
  env = process.env,
  hlsTarget = process.env.MEDIAMTX_HLS_ORIGIN || "http://127.0.0.1:8888",
  webrtcTarget = process.env.MEDIAMTX_WEBRTC_ORIGIN || "http://127.0.0.1:8889",
} = {}) {
  if (typeof listChannels !== "function") throw new Error("listChannels is required");
  const config = activityConfig(env);
  const router = express.Router();
  const sdkDir = resolvePackageDir("@discord/embedded-app-sdk", "output");
  const hlsFile = resolvePackageDir("hls.js", path.join("dist", "hls.min.js"));

  if (config.clientIdInvalid) console.warn("[discord-activity] DISCORD_CLIENT_ID must be the numeric Application ID from the Discord Developer Portal - ignoring it");
  else if (!config.clientId) console.warn("[discord-activity] DISCORD_CLIENT_ID is not set - the page works in a browser but Discord will not load it as an Activity");
  if (!sdkDir || !fs.existsSync(sdkDir)) console.warn("[discord-activity] @discord/embedded-app-sdk is not installed - run npm install in the dashboard folder");
  console.log(`[discord-activity] watch page enabled at /activity (${config.allowed ? `channels: ${[...config.allowed].join(", ")}` : "every live channel on this install"})`);

  router.use((_req, res, next) => { activityHeaders(res); next(); });

  const sendPage = (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(ACTIVITY_DIR, "index.html"));
  };
  router.get("/", sendPage);
  router.get("/index.html", sendPage);
  router.get("/activity-app.js", (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.type("application/javascript").sendFile(path.join(ACTIVITY_DIR, "activity-app.js")); });
  router.get("/activity-app.css", (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.type("text/css").sendFile(path.join(ACTIVITY_DIR, "activity-app.css")); });
  router.get("/logo.png", (_req, res) => res.sendFile(path.join(__dirname, "public", "logo.png")));

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
    res.json({ clientId:config.clientId || null, title:config.title, defaultChannel:config.defaultChannel || null, webrtc:config.webrtc, sdk:!!sdkDir, hls:!!hlsFile });
  });
  router.get("/api/channels", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ channels:visibleChannels(listChannels(), config) });
  });

  const guard = (req, res, next) => {
    if (allowedStreamLogin(req.path, listChannels(), config)) return next();
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
  visibleChannels,
  allowedStreamLogin,
  parseLoginList,
};
