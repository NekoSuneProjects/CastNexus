const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { createOverlayRouter, resolveSceneFragment, withWidgets } = require("./overlays");
const events = require("./events");
const musicEngine = require("./music-engine");
const { Compositor } = require("./compositor");

const PORT = Number(process.env.DASHBOARD_PORT || 8090);
const MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
const MEDIA_HOST = process.env.PI_IP || "127.0.0.1";
// RTMP app-name each source publishes under, so a live path can be
// attributed to a source without any extra signaling:
//   - CONSOLE_APP mirrors the real Twitch ingest scheme
//     (rtmp://live.twitch.tv/app/<key>) that a captured console broadcast
//     arrives under untouched, via the DNS hijack / ARP-spoof intercept.
//   - PC_APP is this project's own convention for OBS/streaming software
//     pointed directly at the dashboard (rtmp://PI_IP:1935/live/<key>).
const CONSOLE_APP = process.env.CONSOLE_APP || "app";
const PC_APP = process.env.PC_APP || "live";
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "data", "state.json");
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(path.dirname(STATE_FILE), "music");
const MUSIC_MAX_BYTES = Number(process.env.MUSIC_MAX_MB || 50) * 1024 * 1024;
const POLL_MS = 1500;
// If a stream drops unexpectedly and no other source is live to fail over
// to, don't end it right away - flaky wifi, a console reboot, or OBS
// crashing/relaunching shouldn't nuke every destination immediately. Wait
// up to this long for the same (or another) source to reconnect before
// actually stopping outputs.
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 60 * 60 * 1000); // 1h
// Where the compositor's own headless Chromium loads /overlay/:login/compositor
// from - always this dashboard's own local HTTP server, since Chromium runs
// on the same machine/container as the dashboard regardless of MEDIA_HOST.
const DASHBOARD_ORIGIN = `http://127.0.0.1:${PORT}`;

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";
const TWITCH_REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || `http://${MEDIA_HOST}:${PORT}/auth/twitch/callback`;

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // migrate old single-tenant shape ({ auth, destinations }) to the
    // multi-account shape - stash the old destinations to attach to
    // whichever account registers first.
    if (loaded.destinations && !loaded.accounts) {
      return {
        accounts: {},
        pendingLegacyDestinations: loaded.destinations,
        sessionSecret: crypto.randomBytes(32).toString("hex"),
      };
    }
    return loaded;
  }
  const state = {
    accounts: {},
    pendingLegacyDestinations: null,
    sessionSecret: crypto.randomBytes(32).toString("hex"),
  };
  saveState(state);
  return state;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const state = loadState();

function generatePcKey() {
  // Ours to generate and regenerate at will - unlike the Twitch stream key,
  // there's no external platform tying this value to anything, so it's
  // safe to display in full and rotate on request.
  return crypto.randomBytes(12).toString("hex");
}

function defaultOverlayConfig() {
  return {
    startingSoon: { title: "Starting Soon", subtitle: "Stream begins shortly", accent: "#7c5cff" },
    brb: { title: "BRB", subtitle: "Be right back", accent: "#8a2bff" },
    ending: { title: "Thanks for watching", subtitle: "Stream over", accent: "#ff2bd6" },
    live: { title: "LIVE", accent: "#35d07f" },
    // Layered on top of every scene (starting soon/BRB/ending/master/custom
    // text&html) when enabled - mirrors CacheStream's OverlayConfigCard
    // widget toggles, ported down to the one widget this project has so far.
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
  // Backfills fields for any account that predates them, so nothing has to
  // migrate state.json by hand.
  let dirty = false;
  if (!account.pcKey) { account.pcKey = generatePcKey(); dirty = true; }
  if (!account.overlayConfig) { account.overlayConfig = defaultOverlayConfig(); dirty = true; }
  if (!account.overlayConfig.nowPlaying) { account.overlayConfig.nowPlaying = { enabled: false, corner: "br" }; dirty = true; }
  if (!account.overlays) { account.overlays = []; dirty = true; }
  if (!account.musicTracks) { account.musicTracks = []; dirty = true; }
  if (!account.musicSettings) { account.musicSettings = defaultMusicSettings(); dirty = true; }
  if (account.currentScene === undefined) { account.currentScene = null; dirty = true; }
  if (account.compositorEnabled === undefined) { account.compositorEnabled = false; dirty = true; }
  if (dirty) saveState(state);
  return account;
}

function getAccountByLogin(login) {
  return Object.values(state.accounts).find(a => a.twitchLogin === login);
}

function findDestination(account, id) {
  return account.destinations.find(d => d.id === id);
}

function maskSecret(value) {
  if (!value || value.length <= 8) return "••••••••";
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

function maskUrl(url) {
  if (url.length <= 12) return "••••••••";
  return url.slice(0, 18) + "••••" + url.slice(-4);
}

function safePathFor(account) {
  // Twitch logins are already URL-safe (alphanumeric + underscore), but
  // fall back to the account id if it's ever missing for some reason.
  return `public/${account.twitchLogin || account.twitchUserId}`;
}

// `${accountId}:${destinationId}` -> ChildProcess (per-destination pushes)
const activeDestinations = new Map();
// accountId -> ChildProcess (per-account republish to a safe public path)
const activeRepublish = new Map();
// MediaMTX path name -> { accountId, source }, for every path currently
// matched and ready - an account can have up to two entries here at once
// (console AND pc live simultaneously), which is exactly what lets both be
// detected independently instead of one hiding the other.
const liveSessions = new Map();
// accountId -> the one pathName currently driving that account's republish +
// destination pushes. Sticky: whichever source went live first keeps
// driving output; if it drops and the other source is still live, output
// fails over to it automatically (see pollLive). Never both at once - two
// simultaneous pushes to the same downstream destination wouldn't work
// anyway (most RTMP targets accept one publisher per stream key).
const activeFeedPath = new Map();
// accountId -> { timer, deadline, pathName, source }, while an account's
// only source has dropped and we're waiting out RECONNECT_GRACE_MS for it
// (or another source) to come back before really ending the stream.
const graceState = new Map();
// accountId -> Compositor instance (dashboard/compositor.js) - only ever
// populated for accounts with compositorEnabled, and only while live.
const compositors = new Map();

function compositedPathFor(accountId) {
  return `composited/${accountId}`;
}

// What a destination push should actually read from right now: the
// composited output when the compositor is enabled (so overlays are baked
// into what viewers see), otherwise the raw source path, unchanged from
// before the compositor existed. Null if nothing is currently active.
function destinationSourcePathFor(account) {
  const pathName = activeFeedPath.get(account.twitchUserId);
  if (!pathName) return null;
  return account.compositorEnabled ? compositedPathFor(account.twitchUserId) : pathName;
}

// Lazily creates (but doesn't start) this account's Compositor, wired up to
// read its own already-republished public/<login> path (stable across
// console/PC failover) and the shared music engine, and to publish to this
// project's own composited/<accountId> MediaMTX path - which destinations
// then read from instead of the raw source when compositorEnabled is set.
function compositorFor(account) {
  let compositor = compositors.get(account.twitchUserId);
  if (!compositor) {
    compositor = new Compositor({
      accountId: account.twitchUserId,
      pageUrl: `${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(account.twitchLogin)}/compositor`,
      audioSourceUrl: `rtmp://127.0.0.1:1935/${safePathFor(account)}`,
      outputUrl: `rtmp://127.0.0.1:1935/${compositedPathFor(account.twitchUserId)}`,
      getMusicNow: () => getMusicNow(getAccount(account.twitchUserId)),
      musicFilePathFor: (trackId) => {
        const acc = getAccount(account.twitchUserId);
        const track = acc?.musicTracks.find(t => t.id === trackId);
        return track ? path.join(MUSIC_DIR, account.twitchUserId, track.filename) : null;
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

function outputFormatFor(url) {
  return url.startsWith("srt://") ? "mpegts" : "flv";
}

const DESTINATION_URL_RE = /^(rtmps?|srt):\/\/.+/i;
const DESTINATION_URL_HINT = "a valid rtmp://, rtmps://, or srt:// url is required";

function startDestination(account, dest, pathName) {
  const key = `${account.twitchUserId}:${dest.id}`;
  if (activeDestinations.has(key) || !dest.enabled) return;
  const source = `rtmp://127.0.0.1:1935/${pathName}`;
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-i", source,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy", "-c:a", "copy",
    "-f", outputFormatFor(dest.url), dest.url,
  ]);
  child.stderr.on("data", () => {}); // drain quietly - ffmpeg is chatty even at "warning"
  child.on("exit", code => {
    activeDestinations.delete(key);
    if (code !== 0) console.log(`[dashboard] ${account.twitchLogin}/${dest.name} push exited (code ${code})`);
    const stillActive = activeFeedPath.get(account.twitchUserId) === pathName;
    const stillWanted = findDestination(account, dest.id)?.enabled;
    if (stillActive && stillWanted) {
      setTimeout(() => { if (activeFeedPath.get(account.twitchUserId) === pathName) startDestination(account, dest, pathName); }, 2000);
    }
  });
  activeDestinations.set(key, child);
  console.log(`[dashboard] started push -> ${account.twitchLogin}/${dest.name}`);
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
  child.stderr.on("data", () => {}); // drain quietly - ffmpeg is chatty even at "warning"
  child.on("exit", code => {
    activeRepublish.delete(account.twitchUserId);
    if (code !== 0) console.log(`[dashboard] ${account.twitchLogin} public republish exited (code ${code})`);
    if (activeFeedPath.get(account.twitchUserId) === pathName) {
      setTimeout(() => { if (activeFeedPath.get(account.twitchUserId) === pathName) startRepublish(account, pathName); }, 2000);
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
  const app = pathName.split("/")[0];
  const key = pathName.split("/").pop();

  // PC pushes are matched by pcKey - a value this project generates and
  // owns, never the account's real Twitch stream key. That key is never
  // handed to third-party software; only the console path (below) uses it.
  if (app === PC_APP) {
    const account = Object.values(state.accounts).find(a => a.pcKey && a.pcKey === key);
    if (!account) return null;
    const mode = account.sourceMode || "both"; // pre-existing accounts default permissive
    if (mode !== "both" && mode !== "pc") return null; // e.g. console-only account, ignore a pc push under its key
    return { account, source: "pc" };
  }

  // Anything else is treated as console - that's the permissive default
  // this project has always used (match by Twitch stream key alone), since
  // a captured console broadcast's real app name comes from Twitch's own
  // ingest scheme and isn't something we control; if it ever doesn't match
  // CONSOLE_APP, still honor it as console rather than silently dropping a
  // real capture.
  const account = Object.values(state.accounts).find(a => a.streamKey && a.streamKey === key);
  if (!account) return null;
  if (app !== CONSOLE_APP) {
    console.log(`[dashboard] note: ${account.twitchLogin} stream matched under app "${app}" (expected "${CONSOLE_APP}" for console) - treating as console`);
  }
  const mode = account.sourceMode || "both";
  if (mode !== "both" && mode !== "console") return null;
  return { account, source: "console" };
}

// The account's active feed path stays set through a reconnect grace window
// (see enterGrace), so activeFeedPath alone can't tell "genuinely streaming
// right now" apart from "waiting to reconnect" - cross-check against
// liveSessions, which only holds paths MediaMTX currently reports ready.
function activeSourceFor(accountId) {
  const path = activeFeedPath.get(accountId);
  return path ? liveSessions.get(path)?.source ?? null : null;
}

function stopOutputsFor(accountId) {
  activeFeedPath.delete(accountId);
  stopAllDestinationsFor(accountId);
  stopRepublish(accountId);
  stopCompositorFor(accountId);
}

function startOutputsFor(account, pathName) {
  activeFeedPath.set(account.twitchUserId, pathName);
  // Republish ALWAYS reads the raw source, compositor state notwithstanding -
  // the compositor itself depends on this stable public/<login> path for its
  // own WHEP video + audio tap (see compositorFor()).
  startRepublish(account, pathName);
  if (account.compositorEnabled) startCompositorFor(account);
  const destinationSource = destinationSourcePathFor(account);
  for (const dest of account.destinations) {
    if (dest.enabled) startDestination(account, dest, destinationSource);
  }
}

function clearGrace(accountId) {
  const g = graceState.get(accountId);
  if (!g) return;
  clearTimeout(g.timer);
  graceState.delete(accountId);
}

// Deliberately does NOT touch activeFeedPath or kill the running
// destination/republish processes - they keep reading from the same dead
// path and retrying every couple seconds on their own (see the "exit"
// handlers in startDestination/startRepublish), so a reconnect within the
// grace window resumes on its own with no extra wiring needed here. Only
// the hard timeout at the end actually calls stopOutputsFor.
function enterGrace(account, pathName, source) {
  if (graceState.has(account.twitchUserId)) return; // already waiting
  const deadline = Date.now() + RECONNECT_GRACE_MS;
  console.log(`[dashboard] ${account.twitchLogin} ${source} disconnected - waiting up to ${Math.round(RECONNECT_GRACE_MS / 60000)}m for reconnect before ending outputs`);
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
    const res = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
    const data = await res.json();
    readyPaths = new Set((data.items || []).filter(p => p.ready).map(p => p.name));
  } catch {
    readyPaths = new Set();
  }

  // path(s) that ended
  for (const [pathName, session] of [...liveSessions.entries()]) {
    if (readyPaths.has(pathName)) continue;
    liveSessions.delete(pathName);
    console.log(`[dashboard] ${session.accountId} ${session.source} stream stopped`);
    if (activeFeedPath.get(session.accountId) !== pathName) continue; // a standby source ending - nothing driving output changes

    // fail over to the other source immediately if it's still live, so e.g.
    // ending the console broadcast while OBS is still pushing doesn't drop
    // the outputs
    const other = [...liveSessions.entries()].find(([, s]) => s.accountId === session.accountId);
    const account = getAccount(session.accountId);
    if (other && account) {
      const [otherPath] = other;
      stopOutputsFor(session.accountId);
      console.log(`[dashboard] ${account.twitchLogin} failing over output to remaining live source`);
      startOutputsFor(account, otherPath);
      continue;
    }

    // no other source live right now - don't tear outputs down yet. Leave
    // activeFeedPath/the running processes alone (they keep retrying the
    // same dead path on their own) and just start the reconnect clock;
    // enterGrace() is a no-op if already waiting.
    if (account) enterGrace(account, pathName, session.source);
  }

  // newly ready path(s)
  for (const pathName of readyPaths) {
    if (liveSessions.has(pathName)) continue;
    const matched = matchAccountForPath(pathName);
    if (!matched) continue; // unregistered stream key, wrong app name, or source not enabled for this account
    const { account, source } = matched;
    liveSessions.set(pathName, { accountId: account.twitchUserId, source });
    console.log(`[dashboard] ${account.twitchLogin} ${source} is live`);

    const wasInGrace = graceState.has(account.twitchUserId);
    if (wasInGrace) {
      clearGrace(account.twitchUserId);
      console.log(`[dashboard] ${account.twitchLogin} reconnected within the grace window`);
    }

    const currentActive = activeFeedPath.get(account.twitchUserId);
    if (currentActive === pathName) continue; // same source resuming - its own retry loop is already picking this back up
    if (currentActive && !wasInGrace) continue; // a different, still-live source already drives output - stay standby

    if (currentActive && wasInGrace) stopOutputsFor(account.twitchUserId); // was waiting on a now-dead path - clear it before switching
    startOutputsFor(account, pathName);
  }
}
setInterval(pollLive, POLL_MS);

const app = express();
// Behind a reverse proxy (e.g. Nginx Proxy Manager) terminating TLS, this
// makes req.secure/X-Forwarded-* honored so sessions work correctly under
// both http and https, on a domain, with or without an explicit port.
app.set("trust proxy", 1);

// MediaMTX issues absolute-path redirects (e.g. its HLS "cookie check"
// bounce) that don't know they're being served under a path prefix -
// rewrite those Location headers to keep the prefix intact.
function fixRedirectPrefix(prefix) {
  return (proxyRes) => {
    const location = proxyRes.headers.location;
    if (location && location.startsWith("/")) {
      proxyRes.headers.location = prefix + location;
    }
  };
}

// HLS and WHEP are plain HTTP, so they can be reverse-proxied through this
// same port/domain (unlike RTSP/SRT, which are raw TCP/UDP and just need
// their own ports exposed directly - no HTTP proxying applies to those).
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

// Public (no auth - OBS Browser Sources can't log in), scoped by twitch
// login the same way the public/<login> playback paths already are.
app.use("/overlay", createOverlayRouter({
  getAccountByLogin,
  musicDir: MUSIC_DIR,
  isLiveFn: account => !!activeSourceFor(account.twitchUserId),
  subscribeEvents: events.subscribe,
  getMusicNow,
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

// The Twitch stream key is only ever needed for console matching - a
// pc-only account never needs one at all (its ingest key is the
// auto-generated pcKey instead), so "onboarded" depends on the chosen mode.
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
  const state_ = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state_;
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("client_id", TWITCH_CLIENT_ID);
  url.searchParams.set("redirect_uri", TWITCH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "");
  url.searchParams.set("state", state_);
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
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "Client-Id": TWITCH_CLIENT_ID,
      },
    });
    const userData = await userRes.json();
    if (!userRes.ok || !userData.data?.[0]) throw new Error("failed to fetch Twitch user info");

    const twitchUser = userData.data[0];
    let account = state.accounts[twitchUser.id];
    const isNewAccount = !account;
    if (!account) {
      account = {
        twitchUserId: twitchUser.id,
        streamKey: null, // real Twitch stream key - only ever needed for console (PS5) matching
        pcKey: generatePcKey(), // dashboard-generated, for PC/software matching - never the Twitch key
        sourceMode: null, // chosen first on login (POST /api/source-mode)
        destinations: state.pendingLegacyDestinations || [],
        overlayConfig: defaultOverlayConfig(),
        overlays: [], // custom overlays: html / text / music, see POST /api/overlays
        musicTracks: [], // uploaded audio for the "music" overlay type
        musicSettings: defaultMusicSettings(),
        currentScene: null, // { kind: "builtin", name } | { kind: "custom", overlayId } | null - see /api/scenes/current
        compositorEnabled: false, // opt-in: bake overlays into the actual outgoing video - see /api/compositor
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
  } catch (e) {
    console.error("[dashboard] Twitch OAuth error:", e.message);
    res.status(500).send("Twitch login failed - please try again");
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Only ever needed for console matching - the first onboarding step is
// picking a source mode (below); this step is skipped entirely for a
// pc-only account, which never needs a Twitch stream key at all.
app.post("/api/streamkey", requireAuth, (req, res) => {
  const { streamKey } = req.body || {};
  if (!streamKey || !String(streamKey).trim()) return res.status(400).json({ error: "stream key is required" });
  req.account.streamKey = String(streamKey).trim();
  saveState(state);
  res.json({ ok: true });
});

// The first onboarding step (and editable anytime after from "Connect a
// source"). No requireOnboarded gate - this is what onboarding starts with.
app.post("/api/source-mode", requireAuth, (req, res) => {
  const { sourceMode } = req.body || {};
  if (!SOURCE_MODES.includes(sourceMode)) {
    return res.status(400).json({ error: "sourceMode must be console, pc, or both" });
  }
  req.account.sourceMode = sourceMode;
  saveState(state);
  res.json({ ok: true });
});

// pcKey is ours to rotate freely (unlike the Twitch stream key) - useful if
// it ever leaks, without touching anything Twitch-related.
app.post("/api/pckey/regenerate", requireAuth, (req, res) => {
  req.account.pcKey = generatePcKey();
  saveState(state);
  res.json({ ok: true, pcKey: req.account.pcKey });
});

// ---- Overlays: built-in scenes (starting soon / BRB / ending / live badge) ----
// Config here is served publicly at /overlay/:login/<name> for use as an OBS
// Browser Source - see dashboard/overlays.js.

app.get("/api/overlays/config", requireAuth, (req, res) => {
  res.json(req.account.overlayConfig);
});

app.post("/api/overlays/config", requireAuth, (req, res) => {
  const body = req.body || {};
  const cfg = req.account.overlayConfig;
  for (const key of ["startingSoon", "brb", "ending", "live", "nowPlaying"]) {
    if (body[key] && typeof body[key] === "object") cfg[key] = { ...cfg[key], ...body[key] };
  }
  saveState(state);
  res.json({ ok: true, overlayConfig: cfg });
});

// ---- Overlays: custom (html / text / music) --------------------------------

const OVERLAY_TYPES = ["html", "text", "music"];

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "overlay";
}

function uniqueSlug(account, base, ignoreId) {
  let slug = base, n = 2;
  while (account.overlays.some(o => o.slug === slug && o.id !== ignoreId)) slug = `${base}-${n++}`;
  return slug;
}

app.get("/api/overlays", requireAuth, (req, res) => {
  res.json({ overlays: req.account.overlays });
});

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
  if (req.account.overlays.length === before) return res.status(404).json({ error: "unknown overlay" });
  saveState(state);
  res.json({ ok: true });
});

// ---- Music library + engine (backs the "music" overlay type and the
// layerable "Now Playing" widget) --------------------------------------------

// One shared now-playing state per account, advanced server-side - see
// dashboard/music-engine.js for why (ported from CacheStream's single
// MusicEngine, minus the audio-mixing pipeline this project has no
// compositor to feed). onAdvance pushes the new state to any open overlay
// SSE connections so a "Now Playing" widget could update instantly rather
// than waiting for its own poll tick, if one's ever added.
function musicEngineFor(accountId) {
  return musicEngine.engineFor(accountId, () => getAccount(accountId), (now) => {
    events.publish(accountId, { type: "music", now });
  });
}

function getMusicNow(account) {
  const engine = musicEngineFor(account.twitchUserId);
  engine.ensureRunning();
  return engine.getNow();
}

const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(MUSIC_DIR, req.account.twitchUserId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: MUSIC_MAX_BYTES },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("audio/")),
});

app.get("/api/music/tracks", requireAuth, (req, res) => {
  res.json({ tracks: req.account.musicTracks });
});

app.post("/api/music/tracks", requireAuth, (req, res) => {
  musicUpload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "upload failed" });
    if (!req.file) return res.status(400).json({ error: "an audio file is required" });
    const filePath = path.join(MUSIC_DIR, req.account.twitchUserId, req.file.filename);
    const durationS = await musicEngine.probeDurationSeconds(filePath);
    const track = {
      id: crypto.randomUUID(),
      title: path.basename(req.file.originalname, path.extname(req.file.originalname)),
      artist: "",
      filename: req.file.filename,
      sizeBytes: req.file.size,
      durationS, // null if ffprobe isn't available - the engine falls back to a fixed guess
      addedAt: new Date().toISOString(),
    };
    req.account.musicTracks.push(track);
    saveState(state);
    musicEngineFor(req.account.twitchUserId).ensureRunning();
    res.json({ ok: true, track });
  });
});

app.put("/api/music/tracks/:id", requireAuth, (req, res) => {
  const track = req.account.musicTracks.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: "unknown track" });
  const { title, artist } = req.body || {};
  if (title !== undefined && String(title).trim()) track.title = String(title).trim();
  if (artist !== undefined) track.artist = String(artist).trim();
  saveState(state);
  res.json({ ok: true, track });
});

app.delete("/api/music/tracks/:id", requireAuth, (req, res) => {
  const track = req.account.musicTracks.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: "unknown track" });
  req.account.musicTracks = req.account.musicTracks.filter(t => t.id !== req.params.id);
  saveState(state);
  fs.unlink(path.join(MUSIC_DIR, req.account.twitchUserId, track.filename), () => {}); // best-effort
  musicEngineFor(req.account.twitchUserId).refresh();
  res.json({ ok: true });
});

// Account-wide playback settings (not per-overlay) - every "music" overlay
// and the Now Playing widget all read the one shared engine, so there's one
// volume/shuffle/loop, not one per overlay - matches CacheStream's own
// single-engine settings (apps/web MusicTab), not a per-scene config.
app.get("/api/music/settings", requireAuth, (req, res) => {
  res.json(req.account.musicSettings);
});

app.post("/api/music/settings", requireAuth, (req, res) => {
  const { shuffle, loop, volume } = req.body || {};
  if (shuffle !== undefined) req.account.musicSettings.shuffle = Boolean(shuffle);
  if (loop !== undefined) req.account.musicSettings.loop = Boolean(loop);
  if (volume !== undefined) {
    const v = Number(volume);
    if (!Number.isFinite(v) || v < 0 || v > 1) return res.status(400).json({ error: "volume must be between 0 and 1" });
    req.account.musicSettings.volume = v;
  }
  saveState(state);
  res.json({ ok: true, musicSettings: req.account.musicSettings });
});

// ---- Scene switching: the master overlay's live "what's showing" state -----
// Instant, no stream restart - see the master route / SSE bus in
// dashboard/overlays.js and dashboard/events.js.

const SCENE_KINDS = ["none", "builtin", "custom"];
const BUILTIN_SCENE_NAMES = ["startingSoon", "brb", "ending"];

app.get("/api/scenes/current", requireAuth, (req, res) => {
  res.json({ currentScene: req.account.currentScene });
});

app.post("/api/scenes/current", requireAuth, (req, res) => {
  const { kind, name, overlayId } = req.body || {};
  if (!SCENE_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${SCENE_KINDS.join(", ")}` });

  let scene = null;
  if (kind === "builtin") {
    if (!BUILTIN_SCENE_NAMES.includes(name)) return res.status(400).json({ error: `name must be one of ${BUILTIN_SCENE_NAMES.join(", ")}` });
    scene = { kind, name };
  } else if (kind === "custom") {
    const overlay = req.account.overlays.find(o => o.id === overlayId && (o.type === "text" || o.type === "html"));
    if (!overlay) return res.status(404).json({ error: "unknown overlay (must be a text or html overlay)" });
    scene = { kind, overlayId };
  }

  req.account.currentScene = scene;
  saveState(state);

  const html = withWidgets(resolveSceneFragment(scene, req.account), req.account.overlayConfig, req.account.twitchLogin);
  events.publish(req.account.twitchUserId, { type: "scene", html });
  res.json({ ok: true, currentScene: scene });
});

// ---- Built-in compositor: bake overlays into the actual outgoing video ----
// Opt-in, off by default - see dashboard/compositor.js for what this
// actually spins up (a persistent headless Chromium + several ffmpeg
// processes per account with it enabled).

app.get("/api/compositor", requireAuth, (req, res) => {
  res.json({ enabled: !!req.account.compositorEnabled });
});

app.post("/api/compositor", requireAuth, (req, res) => {
  req.account.compositorEnabled = Boolean(req.body?.enabled);
  saveState(state);

  // Apply immediately if currently live, rather than waiting for the next
  // reconnect - restart outputs against the same active path so
  // destinations switch to/from the composited path right now.
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
  // HLS/WHEP are proxied through this same request's own domain+scheme
  // (works whether that's a raw LAN IP over http, or a real domain over
  // https via a reverse proxy in front of this dashboard). RTSP/SRT are
  // raw TCP/UDP, not HTTP, so they can't be proxied the same way - they
  // still need their own ports reachable directly at this same host.
  const base = `${req.protocol}://${req.get("host")}`;
  return {
    webPlayer: `${base}/webrtc/${encodedPath}`,
    whep: `${base}/webrtc/${encodedPath}/whep`,
    hls: `${base}/hls/${encodedPath}/index.m3u8`,
    rtsp: `rtsp://${req.hostname}:8554/${safePath}`,
    srt: `srt://${req.hostname}:8890?streamid=read:${safePath}`,
  };
}

// Per-source status: which of console/pc this account is even set up to use
// (per its sourceMode), and whether each is currently live - independently,
// so both can show as live at once instead of one hiding the other.
function sourcesStatusFor(account) {
  const mode = account.sourceMode || "both";
  const sources = {
    console: { enabled: mode === "console" || mode === "both", live: false },
    pc: { enabled: mode === "pc" || mode === "both", live: false },
  };
  for (const session of liveSessions.values()) {
    if (session.accountId === account.twitchUserId) sources[session.source].live = true;
  }
  const activeSource = activeSourceFor(account.twitchUserId);
  return { sources, activeSource };
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
    // Set while a dropped source is within its reconnect grace window -
    // outputs are still running (retrying the dead source on their own),
    // this is purely so the UI can show "reconnecting" instead of "idle".
    graceUntil: graceState.get(account.twitchUserId)?.deadline ?? null,
    // Not secrets - just where PC software should point, and what to set
    // the console's DNS to. pcKey is shown in full on purpose - we
    // generated it, we can rotate it, and OBS needs to see it to be pasted
    // in; it is never the real Twitch stream key, which is never
    // re-displayed (users paste that one from Twitch's own page instead).
    pcServer: `rtmp://${MEDIA_HOST}:1935/${PC_APP}`,
    pcKey: account.pcKey,
    mediaHost: MEDIA_HOST,
    playback: playbackUrlsFor(req, account),
    destinations: account.destinations.map(d => ({
      id: d.id,
      name: d.name,
      urlMasked: maskUrl(d.url),
      enabled: d.enabled,
      active: activeDestinations.has(`${account.twitchUserId}:${d.id}`),
    })),
  });
});

app.post("/api/destinations", requireAuth, requireOnboarded, (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
  if (!url || !DESTINATION_URL_RE.test(url)) return res.status(400).json({ error: DESTINATION_URL_HINT });

  const dest = { id: crypto.randomUUID(), name: String(name).trim(), url: String(url).trim(), enabled: false };
  req.account.destinations.push(dest);
  saveState(state);
  res.json({ ok: true, id: dest.id });
});

app.put("/api/destinations/:id", requireAuth, requireOnboarded, (req, res) => {
  const dest = findDestination(req.account, req.params.id);
  if (!dest) return res.status(404).json({ error: "unknown destination" });

  const { name, url } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: "name cannot be empty" });
    dest.name = String(name).trim();
  }
  if (url !== undefined) {
    if (!DESTINATION_URL_RE.test(url)) return res.status(400).json({ error: DESTINATION_URL_HINT });
    dest.url = String(url).trim();
    const activePathName = destinationSourcePathFor(req.account);
    if (activePathName) {
      stopDestination(req.account.twitchUserId, dest.id);
      startDestination(req.account, dest, activePathName);
    }
  }
  saveState(state);
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

  const activePathName = destinationSourcePathFor(req.account);
  if (activePathName) {
    if (dest.enabled) startDestination(req.account, dest, activePathName); else stopDestination(req.account.twitchUserId, dest.id);
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
