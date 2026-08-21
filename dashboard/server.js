const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const express = require("express");
const session = require("express-session");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { createOverlayRouter, resolveSceneFragment, withWidgets } = require("./overlays");
const events = require("./events");
const musicEngine = require("./music-engine");
const { Compositor } = require("./compositor");
const { createProfileMusicService } = require("./profile-music");
const { createProfileVodService } = require("./profile-vod");
const { OUTPUT_LAYOUTS, normaliseLayout, destinationFfmpegArgs } = require("./destination-output");

const PORT = Number(process.env.DASHBOARD_PORT || 8090);
const MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
const MEDIA_HOST = process.env.PI_IP || "127.0.0.1";
const CONSOLE_APP = process.env.CONSOLE_APP || "app";
const PC_APP = process.env.PC_APP || "live";
const RELAY_APP = process.env.RELAY_APP || "relay";
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "data", "state.json");
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(path.dirname(STATE_FILE), "music");
const VOD_DIR = process.env.VOD_DIR || path.join(path.dirname(STATE_FILE), "vod");
const MUSIC_MAX_BYTES = Number(process.env.MUSIC_MAX_MB || 50) * 1024 * 1024;
const VOD_MAX_BYTES = Number(process.env.VOD_MAX_GB || 20) * 1024 * 1024 * 1024;
const POLL_MS = 1500;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 60 * 60 * 1000);
const DASHBOARD_ORIGIN = `http://127.0.0.1:${PORT}`;
const RTMP_ORIGIN = process.env.MEDIA_RTMP_ORIGIN || "rtmp://127.0.0.1:1935";

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";
const TWITCH_REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || `http://${MEDIA_HOST}:${PORT}/auth/twitch/callback`;

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (loaded.destinations && !loaded.accounts) {
      return {
        accounts: {},
        pendingLegacyDestinations: loaded.destinations,
        sessionSecret: crypto.randomBytes(32).toString("hex"),
      };
    }
    if (!loaded.sessionSecret) loaded.sessionSecret = crypto.randomBytes(32).toString("hex");
    if (!loaded.accounts) loaded.accounts = {};
    return loaded;
  }
  const initial = {
    accounts: {},
    pendingLegacyDestinations: null,
    sessionSecret: crypto.randomBytes(32).toString("hex"),
  };
  saveState(initial);
  return initial;
}

function saveState(nextState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
}

const state = loadState();

function generatePcKey() {
  return crypto.randomBytes(12).toString("hex");
}

function defaultOverlayConfig() {
  return {
    startingSoon: { title: "Starting Soon", subtitle: "Stream begins shortly", accent: "#7c5cff" },
    brb: { title: "BRB", subtitle: "Be right back", accent: "#8a2bff" },
    ending: { title: "Thanks for watching", subtitle: "Stream over", accent: "#ff2bd6" },
    live: { title: "LIVE", accent: "#35d07f" },
    nowPlaying: { enabled: false, corner: "br" },
  };
}

function defaultMusicSettings() {
  return { shuffle: false, loop: true, volume: 0.7 };
}

function getAccount(id) {
  if (!id) return undefined;
  const account = state.accounts[id];
  if (!account) return account;
  let dirty = false;
  if (!account.pcKey) { account.pcKey = generatePcKey(); dirty = true; }
  if (!account.destinations) { account.destinations = []; dirty = true; }
  if (!account.overlayConfig) { account.overlayConfig = defaultOverlayConfig(); dirty = true; }
  if (!account.overlayConfig.nowPlaying) { account.overlayConfig.nowPlaying = { enabled: false, corner: "br" }; dirty = true; }
  if (!account.overlays) { account.overlays = []; dirty = true; }
  if (!Array.isArray(account.musicTracks)) { account.musicTracks = []; dirty = true; }
  if (!account.musicSettings) { account.musicSettings = defaultMusicSettings(); dirty = true; }
  if (!account.musicProfiles || typeof account.musicProfiles !== "object" || Array.isArray(account.musicProfiles)) { account.musicProfiles = {}; dirty = true; }
  if (!account.vodProfiles || typeof account.vodProfiles !== "object" || Array.isArray(account.vodProfiles)) { account.vodProfiles = {}; dirty = true; }
  if (account.currentScene === undefined) { account.currentScene = null; dirty = true; }
  if (account.compositorEnabled === undefined) { account.compositorEnabled = false; dirty = true; }
  for (const dest of account.destinations) {
    const layout = normaliseLayout(dest.layout);
    if (dest.layout !== layout) { dest.layout = layout; dirty = true; }
  }
  if (dirty) saveState(state);
  return account;
}

function getAccountByLogin(login) {
  return Object.values(state.accounts).find(a => a.twitchLogin === login);
}

const profileMusic = createProfileMusicService({
  state,
  saveState,
  musicDir: MUSIC_DIR,
  maxBytes: MUSIC_MAX_BYTES,
  musicEngine,
  events,
});

const profileVod = createProfileVodService({
  state,
  saveState,
  vodDir: VOD_DIR,
  maxBytes: VOD_MAX_BYTES,
  probeDurationSeconds: musicEngine.probeDurationSeconds,
  rtmpOrigin: RTMP_ORIGIN,
});

function findDestination(account, id) {
  return account.destinations.find(d => d.id === id);
}

function maskSecret(value) {
  if (!value || value.length <= 8) return "••••••••";
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

function maskUrl(url) {
  if (!url || url.length <= 12) return "••••••••";
  return url.slice(0, 18) + "••••" + url.slice(-4);
}

function safePathFor(account) {
  return `public/${account.twitchLogin || account.twitchUserId}`;
}

const activeDestinations = new Map();
const activeRepublish = new Map();
const liveSessions = new Map();
const activeFeedPath = new Map();
const graceState = new Map();
const compositors = new Map();

function compositedPathFor(accountId) {
  return `composited/${accountId}`;
}

function destinationSourcePathFor(account) {
  const pathName = activeFeedPath.get(account.twitchUserId);
  if (!pathName) return null;
  return account.compositorEnabled ? compositedPathFor(account.twitchUserId) : pathName;
}

function compositorFor(account) {
  let compositor = compositors.get(account.twitchUserId);
  if (!compositor) {
    compositor = new Compositor({
      accountId: account.twitchUserId,
      pageUrl: `${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(account.twitchLogin)}/compositor`,
      audioSourceUrl: `rtmp://127.0.0.1:1935/${safePathFor(account)}`,
      outputUrl: `rtmp://127.0.0.1:1935/${compositedPathFor(account.twitchUserId)}`,
      getMusicNow: () => profileMusic.getNow(getAccount(account.twitchUserId), null, { respectScene: true }),
      musicFilePathFor: (trackId) => {
        const acc = getAccount(account.twitchUserId);
        const profile = profileMusic.activeProfileFor(acc);
        return profile ? profileMusic.filePathFor(acc, profile.id, trackId) : null;
      },
    });
    compositors.set(account.twitchUserId, compositor);
  }
  return compositor;
}

function startCompositorFor(account) {
  if (!account.compositorEnabled) return;
  compositorFor(account).start();
}

function stopCompositorFor(accountId) {
  const compositor = compositors.get(accountId);
  if (compositor) compositor.stop();
}

const DESTINATION_URL_RE = /^(rtmps?|srt):\/\/.+/i;
const DESTINATION_URL_HINT = "a valid rtmp://, rtmps://, or srt:// url is required";

function startDestination(account, dest, pathName) {
  const key = `${account.twitchUserId}:${dest.id}`;
  if (activeDestinations.has(key) || !dest.enabled || !pathName) return;
  const source = `rtmp://127.0.0.1:1935/${pathName}`;
  const child = spawn("ffmpeg", destinationFfmpegArgs(source, dest));
  child.stderr.on("data", () => {});
  child.on("exit", code => {
    activeDestinations.delete(key);
    if (code !== 0) console.log(`[dashboard] ${account.twitchLogin}/${dest.name} push exited (code ${code})`);
    const stillWanted = findDestination(account, dest.id)?.enabled;
    const stillSource = destinationSourcePathFor(account) === pathName;
    if (stillSource && stillWanted) {
      setTimeout(() => {
        if (destinationSourcePathFor(account) === pathName) startDestination(account, findDestination(account, dest.id) || dest, pathName);
      }, 2000);
    }
  });
  activeDestinations.set(key, child);
  console.log(`[dashboard] started push -> ${account.twitchLogin}/${dest.name} (${normaliseLayout(dest.layout)})`);
}

function stopDestination(accountId, destId) {
  const key = `${accountId}:${destId}`;
  const child = activeDestinations.get(key);
  if (!child) return;
  child.removeAllListeners("exit");
  child.kill("SIGTERM");
  activeDestinations.delete(key);
}

function stopAllDestinationsFor(accountId) {
  for (const key of [...activeDestinations.keys()]) {
    if (key.startsWith(`${accountId}:`)) stopDestination(accountId, key.split(":")[1]);
  }
}

function startRepublish(account, pathName) {
  if (activeRepublish.has(account.twitchUserId)) return;
  const source = `rtmp://127.0.0.1:1935/${pathName}`;
  const dest = `rtmp://127.0.0.1:1935/${safePathFor(account)}`;
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-i", source,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy", "-c:a", "copy",
    "-f", "flv", dest,
  ]);
  child.stderr.on("data", () => {});
  child.on("exit", code => {
    activeRepublish.delete(account.twitchUserId);
    if (code !== 0) console.log(`[dashboard] ${account.twitchLogin} public republish exited (code ${code})`);
    if (activeFeedPath.get(account.twitchUserId) === pathName) {
      setTimeout(() => {
        if (activeFeedPath.get(account.twitchUserId) === pathName) startRepublish(account, pathName);
      }, 2000);
    }
  });
  activeRepublish.set(account.twitchUserId, child);
  console.log(`[dashboard] ${account.twitchLogin} public republish -> ${safePathFor(account)}`);
}

function stopRepublish(accountId) {
  const child = activeRepublish.get(accountId);
  if (!child) return;
  child.removeAllListeners("exit");
  child.kill("SIGTERM");
  activeRepublish.delete(accountId);
}

function matchAccountForPath(pathName) {
  const appName = pathName.split("/")[0];
  const key = pathName.split("/").pop();

  // Both OBS/encoder input and CastNexus's internal Twitch/VOD relay use the
  // generated PC key, but live under separate MediaMTX applications so they
  // never publish to the same path.
  if (appName === PC_APP || appName === RELAY_APP) {
    const account = Object.values(state.accounts).find(a => a.pcKey && a.pcKey === key);
    if (!account) return null;
    const mode = account.sourceMode || "both";
    if (mode !== "both" && mode !== "pc") return null;
    return { account: getAccount(account.twitchUserId), source: appName === RELAY_APP ? "rerun" : "pc" };
  }

  const account = Object.values(state.accounts).find(a => a.streamKey && a.streamKey === key);
  if (!account) return null;
  if (appName !== CONSOLE_APP) {
    console.log(`[dashboard] note: ${account.twitchLogin} stream matched under app "${appName}" (expected "${CONSOLE_APP}") - treating as console`);
  }
  const mode = account.sourceMode || "both";
  if (mode !== "both" && mode !== "console") return null;
  return { account: getAccount(account.twitchUserId), source: "console" };
}

function activeSourceFor(accountId) {
  const activePath = activeFeedPath.get(accountId);
  return activePath ? liveSessions.get(activePath)?.source ?? null : null;
}

function stopOutputsFor(accountId) {
  activeFeedPath.delete(accountId);
  stopAllDestinationsFor(accountId);
  stopRepublish(accountId);
  stopCompositorFor(accountId);
}

function startOutputsFor(account, pathName) {
  activeFeedPath.set(account.twitchUserId, pathName);
  startRepublish(account, pathName);
  if (account.compositorEnabled) startCompositorFor(account);
  const destinationSource = destinationSourcePathFor(account);
  for (const dest of account.destinations) {
    if (dest.enabled) startDestination(account, dest, destinationSource);
  }
}

function clearGrace(accountId) {
  const grace = graceState.get(accountId);
  if (!grace) return;
  clearTimeout(grace.timer);
  graceState.delete(accountId);
}

function enterGrace(account, pathName, source) {
  if (graceState.has(account.twitchUserId)) return;
  const deadline = Date.now() + RECONNECT_GRACE_MS;
  console.log(`[dashboard] ${account.twitchLogin} ${source} disconnected - waiting up to ${Math.round(RECONNECT_GRACE_MS / 60000)}m`);
  const timer = setTimeout(() => {
    console.log(`[dashboard] ${account.twitchLogin} did not reconnect within the grace window - ending stream`);
    graceState.delete(account.twitchUserId);
    stopOutputsFor(account.twitchUserId);
  }, RECONNECT_GRACE_MS);
  graceState.set(account.twitchUserId, { timer, deadline, pathName, source });
}

async function pollLive() {
  let readyPaths;
  try {
    const response = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
    const data = await response.json();
    readyPaths = new Set((data.items || []).filter(item => item.ready).map(item => item.name));
  } catch {
    readyPaths = new Set();
  }

  for (const [pathName, live] of [...liveSessions.entries()]) {
    if (readyPaths.has(pathName)) continue;
    liveSessions.delete(pathName);
    console.log(`[dashboard] ${live.accountId} ${live.source} stream stopped`);
    if (activeFeedPath.get(live.accountId) !== pathName) continue;

    const other = [...liveSessions.entries()].find(([, s]) => s.accountId === live.accountId);
    const account = getAccount(live.accountId);
    if (other && account) {
      const [otherPath] = other;
      stopOutputsFor(live.accountId);
      console.log(`[dashboard] ${account.twitchLogin} failing over output to remaining live source`);
      startOutputsFor(account, otherPath);
      continue;
    }
    if (account) enterGrace(account, pathName, live.source);
  }

  for (const pathName of readyPaths) {
    if (liveSessions.has(pathName)) continue;
    const matched = matchAccountForPath(pathName);
    if (!matched) continue;
    const { account, source } = matched;
    liveSessions.set(pathName, { accountId: account.twitchUserId, source });
    console.log(`[dashboard] ${account.twitchLogin} ${source} is live`);

    const wasInGrace = graceState.has(account.twitchUserId);
    if (wasInGrace) {
      clearGrace(account.twitchUserId);
      console.log(`[dashboard] ${account.twitchLogin} reconnected within the grace window`);
    }

    const currentActive = activeFeedPath.get(account.twitchUserId);
    if (currentActive === pathName) continue;
    if (currentActive && !wasInGrace) continue;
    if (currentActive && wasInGrace) stopOutputsFor(account.twitchUserId);
    startOutputsFor(account, pathName);
  }
}
setInterval(pollLive, POLL_MS);

const app = express();
app.set("trust proxy", 1);

function fixRedirectPrefix(prefix) {
  return proxyRes => {
    const location = proxyRes.headers.location;
    if (location && location.startsWith("/")) proxyRes.headers.location = prefix + location;
  };
}

app.use("/hls", createProxyMiddleware({
  target: "http://127.0.0.1:8888",
  changeOrigin: true,
  pathRewrite: { "^/hls": "" },
  ws: true,
  onProxyRes: fixRedirectPrefix("/hls"),
}));
app.use("/webrtc", createProxyMiddleware({
  target: "http://127.0.0.1:8889",
  changeOrigin: true,
  pathRewrite: { "^/webrtc": "" },
  ws: true,
  onProxyRes: fixRedirectPrefix("/webrtc"),
}));

app.use("/overlay", createOverlayRouter({
  getAccountByLogin,
  musicDir: MUSIC_DIR,
  isLiveFn: account => !!activeSourceFor(account.twitchUserId),
  subscribeEvents: events.subscribe,
  getMusicNow: (account, profileId, options) => profileMusic.getNow(account, profileId, options),
  getMusicState: (account, profileId) => profileMusic.bucketFor(account, profileId, { create: false }),
  getActiveProfile: account => profileMusic.activeProfileFor(account),
  musicFilePathFor: (account, profileId, trackId) => profileMusic.filePathFor(account, profileId, trackId),
}));

app.use(express.json());
app.use(session({
  secret: state.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: "auto" },
}));

function requireAuth(req, res, next) {
  const account = getAccount(req.session.accountId);
  if (!account) return res.status(401).json({ error: "not authenticated" });
  req.account = account;
  next();
}

const SOURCE_MODES = ["console", "pc", "both"];

function needsStreamKeyFor(account) {
  return (account.sourceMode === "console" || account.sourceMode === "both") && !account.streamKey;
}

function requireOnboarded(req, res, next) {
  if (!req.account.sourceMode) return res.status(403).json({ error: "pick a source mode first" });
  if (needsStreamKeyFor(req.account)) return res.status(403).json({ error: "must set stream key" });
  next();
}

app.get("/auth/twitch", (req, res) => {
  if (!TWITCH_CLIENT_ID) return res.status(500).send("TWITCH_CLIENT_ID is not configured");
  const oauthState = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = oauthState;
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("client_id", TWITCH_CLIENT_ID);
  url.searchParams.set("redirect_uri", TWITCH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "");
  url.searchParams.set("state", oauthState);
  res.redirect(url.toString());
});

app.get("/auth/twitch/callback", async (req, res) => {
  const { code, state: returnedState, error, error_description } = req.query;
  if (error) return res.status(400).send(`Twitch login failed: ${error_description || error}`);
  if (!code || !returnedState || returnedState !== req.session.oauthState) {
    return res.status(400).send("Invalid OAuth state - please try logging in again");
  }
  delete req.session.oauthState;

  try {
    const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: TWITCH_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenData.message || "token exchange failed");

    const userRes = await fetch("https://api.twitch.tv/helix/users", {
      headers: { "Authorization": `Bearer ${tokenData.access_token}`, "Client-Id": TWITCH_CLIENT_ID },
    });
    const userData = await userRes.json();
    if (!userRes.ok || !userData.data?.[0]) throw new Error("failed to fetch Twitch user info");

    const twitchUser = userData.data[0];
    let account = state.accounts[twitchUser.id];
    const isNewAccount = !account;
    if (!account) {
      account = {
        twitchUserId: twitchUser.id,
        streamKey: null,
        pcKey: generatePcKey(),
        sourceMode: null,
        destinations: state.pendingLegacyDestinations || [],
        overlayConfig: defaultOverlayConfig(),
        overlays: [],
        musicTracks: [],
        musicSettings: defaultMusicSettings(),
        musicProfiles: {},
        vodProfiles: {},
        currentScene: null,
        compositorEnabled: false,
        createdAt: new Date().toISOString(),
      };
      state.accounts[twitchUser.id] = account;
      if (state.pendingLegacyDestinations) {
        console.log(`[dashboard] migrated legacy destinations to new account ${twitchUser.login}`);
        state.pendingLegacyDestinations = null;
      }
    }
    account.twitchLogin = twitchUser.login;
    account.displayName = twitchUser.display_name;
    account.profileImageUrl = twitchUser.profile_image_url;
    saveState(state);

    req.session.accountId = twitchUser.id;
    console.log(`[dashboard] ${isNewAccount ? "registered" : "logged in"}: ${twitchUser.login}`);
    res.redirect("/");
  } catch (err) {
    console.error("[dashboard] Twitch OAuth error:", err.message);
    res.status(500).send("Twitch login failed - please try again");
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post("/api/streamkey", requireAuth, (req, res) => {
  const { streamKey } = req.body || {};
  if (!streamKey || !String(streamKey).trim()) return res.status(400).json({ error: "stream key is required" });
  req.account.streamKey = String(streamKey).trim();
  saveState(state);
  res.json({ ok: true });
});

app.post("/api/source-mode", requireAuth, (req, res) => {
  const { sourceMode } = req.body || {};
  if (!SOURCE_MODES.includes(sourceMode)) return res.status(400).json({ error: "sourceMode must be console, pc, or both" });
  req.account.sourceMode = sourceMode;
  saveState(state);
  res.json({ ok: true });
});

app.post("/api/pckey/regenerate", requireAuth, (req, res) => {
  req.account.pcKey = generatePcKey();
  saveState(state);
  res.json({ ok: true, pcKey: req.account.pcKey });
});

app.get("/api/overlays/config", requireAuth, (req, res) => res.json(req.account.overlayConfig));
app.post("/api/overlays/config", requireAuth, (req, res) => {
  const body = req.body || {};
  const cfg = req.account.overlayConfig;
  for (const key of ["startingSoon", "brb", "ending", "live", "nowPlaying"]) {
    if (body[key] && typeof body[key] === "object") cfg[key] = { ...cfg[key], ...body[key] };
  }
  saveState(state);
  res.json({ ok: true, overlayConfig: cfg });
});

const OVERLAY_TYPES = ["html", "text", "music"];
function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "overlay";
}
function uniqueSlug(account, base, ignoreId) {
  let slug = base, n = 2;
  while (account.overlays.some(o => o.slug === slug && o.id !== ignoreId)) slug = `${base}-${n++}`;
  return slug;
}

app.get("/api/overlays", requireAuth, (req, res) => res.json({ overlays: req.account.overlays }));
app.post("/api/overlays", requireAuth, (req, res) => {
  const { name, type, config } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
  if (!OVERLAY_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of ${OVERLAY_TYPES.join(", ")}` });
  const overlay = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    slug: uniqueSlug(req.account, slugify(name)),
    type,
    config: config && typeof config === "object" ? config : {},
    createdAt: new Date().toISOString(),
  };
  req.account.overlays.push(overlay);
  saveState(state);
  res.json({ ok: true, overlay });
});
app.put("/api/overlays/:id", requireAuth, (req, res) => {
  const overlay = req.account.overlays.find(o => o.id === req.params.id);
  if (!overlay) return res.status(404).json({ error: "unknown overlay" });
  const { name, config } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: "name cannot be empty" });
    overlay.name = String(name).trim();
    overlay.slug = uniqueSlug(req.account, slugify(overlay.name), overlay.id);
  }
  if (config !== undefined && typeof config === "object") overlay.config = { ...overlay.config, ...config };
  overlay.updatedAt = new Date().toISOString();
  saveState(state);
  res.json({ ok: true, overlay });
});
app.delete("/api/overlays/:id", requireAuth, (req, res) => {
  const before = req.account.overlays.length;
  req.account.overlays = req.account.overlays.filter(o => o.id !== req.params.id);
  if (before === req.account.overlays.length) return res.status(404).json({ error: "unknown overlay" });
  saveState(state);
  res.json({ ok: true });
});

app.use("/api/music", requireAuth, profileMusic.createApiRouter());
app.use("/api/vod", requireAuth, profileVod.createApiRouter());

const SCENE_KINDS = ["none", "builtin", "custom"];
const BUILTIN_SCENE_NAMES = ["startingSoon", "brb", "ending"];
app.get("/api/scenes/current", requireAuth, (req, res) => res.json({ currentScene: req.account.currentScene }));
app.post("/api/scenes/current", requireAuth, (req, res) => {
  const { kind, name, overlayId } = req.body || {};
  if (!SCENE_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${SCENE_KINDS.join(", ")}` });
  let scene = null;
  if (kind === "builtin") {
    if (!BUILTIN_SCENE_NAMES.includes(name)) return res.status(400).json({ error: `name must be one of ${BUILTIN_SCENE_NAMES.join(", ")}` });
    scene = { kind, name };
    if (name === "startingSoon") {
      const minutes = Number(req.account.overlayConfig?.startingSoon?.countdownMinutes || 0);
      if (Number.isFinite(minutes) && minutes > 0) scene.countdownAt = new Date(Date.now() + minutes * 60_000).toISOString();
    }
  } else if (kind === "custom") {
    const overlay = req.account.overlays.find(o => o.id === overlayId && (o.type === "text" || o.type === "html" || o.type === "music"));
    if (!overlay) return res.status(404).json({ error: "unknown overlay" });
    scene = { kind, overlayId };
  }
  req.account.currentScene = scene;
  saveState(state);
  const html = withWidgets(resolveSceneFragment(scene, req.account), req.account.overlayConfig, req.account.twitchLogin);
  events.publish(req.account.twitchUserId, { type: "scene", html });
  res.json({ ok: true, currentScene: scene });
});

app.get("/api/compositor", requireAuth, (req, res) => res.json({ enabled: !!req.account.compositorEnabled }));
app.post("/api/compositor", requireAuth, (req, res) => {
  req.account.compositorEnabled = Boolean(req.body?.enabled);
  saveState(state);
  const activePath = activeFeedPath.get(req.account.twitchUserId);
  if (activePath) {
    stopOutputsFor(req.account.twitchUserId);
    startOutputsFor(req.account, activePath);
  }
  res.json({ ok: true, enabled: req.account.compositorEnabled });
});

function playbackUrlsFor(req, account) {
  if (!activeSourceFor(account.twitchUserId)) return null;
  const safePath = safePathFor(account);
  const encodedPath = safePath.split("/").map(encodeURIComponent).join("/");
  const base = `${req.protocol}://${req.get("host")}`;
  return {
    webPlayer: `${base}/webrtc/${encodedPath}`,
    whep: `${base}/webrtc/${encodedPath}/whep`,
    hls: `${base}/hls/${encodedPath}/index.m3u8`,
    rtsp: `rtsp://${req.hostname}:8554/${safePath}`,
    srt: `srt://${req.hostname}:8890?streamid=read:${safePath}`,
  };
}

function sourcesStatusFor(account) {
  const mode = account.sourceMode || "both";
  const pcEnabled = mode === "pc" || mode === "both";
  const sources = {
    console: { enabled: mode === "console" || mode === "both", live: false },
    pc: { enabled: pcEnabled, live: false },
    rerun: { enabled: pcEnabled, live: false },
  };
  for (const live of liveSessions.values()) {
    if (live.accountId === account.twitchUserId && sources[live.source]) sources[live.source].live = true;
  }
  return { sources, activeSource: activeSourceFor(account.twitchUserId) };
}

app.get("/api/status", requireAuth, (req, res) => {
  const account = req.account;
  const { sources, activeSource } = sourcesStatusFor(account);
  res.json({
    twitchLogin: account.twitchLogin,
    displayName: account.displayName,
    profileImageUrl: account.profileImageUrl,
    needsSourceMode: !account.sourceMode,
    needsStreamKey: needsStreamKeyFor(account),
    streamKeyMasked: account.streamKey ? maskSecret(account.streamKey) : null,
    sourceMode: account.sourceMode || null,
    live: !!activeSource,
    sources,
    activeSource,
    rerun: profileVod.publicStatus(account.twitchUserId),
    graceUntil: graceState.get(account.twitchUserId)?.deadline ?? null,
    pcServer: `rtmp://${MEDIA_HOST}:1935/${PC_APP}`,
    pcKey: account.pcKey,
    mediaHost: MEDIA_HOST,
    playback: playbackUrlsFor(req, account),
    destinations: account.destinations.map(d => ({
      id: d.id,
      name: d.name,
      urlMasked: maskUrl(d.url),
      layout: normaliseLayout(d.layout),
      enabled: d.enabled,
      active: activeDestinations.has(`${account.twitchUserId}:${d.id}`),
    })),
  });
});

app.post("/api/destinations", requireAuth, requireOnboarded, (req, res) => {
  const { name, url, layout } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
  if (!url || !DESTINATION_URL_RE.test(url)) return res.status(400).json({ error: DESTINATION_URL_HINT });
  if (layout !== undefined && !OUTPUT_LAYOUTS.includes(layout)) return res.status(400).json({ error: `layout must be one of ${OUTPUT_LAYOUTS.join(", ")}` });
  const dest = { id: crypto.randomUUID(), name: String(name).trim(), url: String(url).trim(), layout: normaliseLayout(layout), enabled: false };
  req.account.destinations.push(dest);
  saveState(state);
  res.json({ ok: true, id: dest.id });
});

app.put("/api/destinations/:id", requireAuth, requireOnboarded, (req, res) => {
  const dest = findDestination(req.account, req.params.id);
  if (!dest) return res.status(404).json({ error: "unknown destination" });
  const { name, url, layout } = req.body || {};
  let restart = false;
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: "name cannot be empty" });
    dest.name = String(name).trim();
  }
  if (url !== undefined) {
    if (!DESTINATION_URL_RE.test(url)) return res.status(400).json({ error: DESTINATION_URL_HINT });
    dest.url = String(url).trim();
    restart = true;
  }
  if (layout !== undefined) {
    if (!OUTPUT_LAYOUTS.includes(layout)) return res.status(400).json({ error: `layout must be one of ${OUTPUT_LAYOUTS.join(", ")}` });
    if (dest.layout !== layout) { dest.layout = layout; restart = true; }
  }
  saveState(state);
  const source = destinationSourcePathFor(req.account);
  if (restart && source && dest.enabled) {
    stopDestination(req.account.twitchUserId, dest.id);
    startDestination(req.account, dest, source);
  }
  res.json({ ok: true });
});

app.delete("/api/destinations/:id", requireAuth, requireOnboarded, (req, res) => {
  const dest = findDestination(req.account, req.params.id);
  if (!dest) return res.status(404).json({ error: "unknown destination" });
  stopDestination(req.account.twitchUserId, dest.id);
  req.account.destinations = req.account.destinations.filter(d => d.id !== dest.id);
  saveState(state);
  res.json({ ok: true });
});

app.post("/api/destinations/:id/toggle", requireAuth, requireOnboarded, (req, res) => {
  const dest = findDestination(req.account, req.params.id);
  if (!dest) return res.status(404).json({ error: "unknown destination" });
  dest.enabled = Boolean(req.body?.enabled);
  saveState(state);
  const source = destinationSourcePathFor(req.account);
  if (source) {
    if (dest.enabled) startDestination(req.account, dest, source);
    else stopDestination(req.account.twitchUserId, dest.id);
  }
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`[dashboard] listening on :${PORT}`);
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.warn("[dashboard] TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET are not set - Twitch login will not work");
  }
});
