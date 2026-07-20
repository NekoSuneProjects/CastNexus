const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const express = require("express");
const session = require("express-session");
const { createProxyMiddleware } = require("http-proxy-middleware");

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
const POLL_MS = 1500;
// If a stream drops unexpectedly and no other source is live to fail over
// to, don't end it right away - flaky wifi, a console reboot, or OBS
// crashing/relaunching shouldn't nuke every destination immediately. Wait
// up to this long for the same (or another) source to reconnect before
// actually stopping outputs.
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 60 * 60 * 1000); // 1h

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

function getAccount(id) {
  return id ? state.accounts[id] : undefined;
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
  const account = Object.values(state.accounts).find(a => a.streamKey && a.streamKey === key);
  if (!account) return null;

  // PC_APP is our own convention (we control the server URL people paste
  // into OBS), so it's a reliable signal. Anything else is treated as
  // console - that's the permissive default this project has always used
  // (match by stream key alone), since a captured console broadcast's real
  // app name comes from Twitch's own ingest scheme and isn't something we
  // control; if it ever doesn't match CONSOLE_APP, still honor it as
  // console rather than silently dropping a real capture.
  const source = app === PC_APP ? "pc" : "console";
  if (source === "console" && app !== CONSOLE_APP) {
    console.log(`[dashboard] note: ${account.twitchLogin} stream matched under app "${app}" (expected "${CONSOLE_APP}" for console) - treating as console`);
  }

  const mode = account.sourceMode || "both"; // pre-existing accounts default permissive
  if (mode !== "both" && mode !== source) return null; // e.g. console-only account, ignore a pc push under the same key
  return { account, source };
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
}

function startOutputsFor(account, pathName) {
  activeFeedPath.set(account.twitchUserId, pathName);
  startRepublish(account, pathName);
  for (const dest of account.destinations) {
    if (dest.enabled) startDestination(account, dest, pathName);
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

function requireStreamKey(req, res, next) {
  if (!req.account.streamKey) return res.status(403).json({ error: "must set stream key" });
  next();
}

const SOURCE_MODES = ["console", "pc", "both"];

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
        streamKey: null,
        sourceMode: null, // chosen alongside the stream key on first login (POST /api/streamkey)
        destinations: state.pendingLegacyDestinations || [],
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

app.post("/api/streamkey", requireAuth, (req, res) => {
  const { streamKey, sourceMode } = req.body || {};
  if (!streamKey || !String(streamKey).trim()) return res.status(400).json({ error: "stream key is required" });
  if (!SOURCE_MODES.includes(sourceMode)) {
    return res.status(400).json({ error: "sourceMode must be console, pc, or both" });
  }
  req.account.streamKey = String(streamKey).trim();
  req.account.sourceMode = sourceMode;
  saveState(state);
  res.json({ ok: true });
});

// Lets an account change how it's captured later on, without re-running the
// whole onboarding step (e.g. adding a PC after starting console-only).
app.post("/api/source-mode", requireAuth, requireStreamKey, (req, res) => {
  const { sourceMode } = req.body || {};
  if (!SOURCE_MODES.includes(sourceMode)) {
    return res.status(400).json({ error: "sourceMode must be console, pc, or both" });
  }
  req.account.sourceMode = sourceMode;
  saveState(state);
  res.json({ ok: true });
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
    needsStreamKey: !account.streamKey,
    needsSourceMode: !account.sourceMode,
    streamKeyMasked: account.streamKey ? maskSecret(account.streamKey) : null,
    sourceMode: account.sourceMode || "both",
    live: !!activeSource,
    sources,
    activeSource,
    // Set while a dropped source is within its reconnect grace window -
    // outputs are still running (retrying the dead source on their own),
    // this is purely so the UI can show "reconnecting" instead of "idle".
    graceUntil: graceState.get(account.twitchUserId)?.deadline ?? null,
    // Not secrets - just where OBS/streaming software should point, and
    // what to set the PS5's DNS to. The stream key itself is never
    // re-displayed (users paste the same one they already saved via the
    // stream-key step, from Twitch's own page).
    pcServer: `rtmp://${MEDIA_HOST}:1935/${PC_APP}`,
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

app.post("/api/destinations", requireAuth, requireStreamKey, (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
  if (!url || !DESTINATION_URL_RE.test(url)) return res.status(400).json({ error: DESTINATION_URL_HINT });

  const dest = { id: crypto.randomUUID(), name: String(name).trim(), url: String(url).trim(), enabled: false };
  req.account.destinations.push(dest);
  saveState(state);
  res.json({ ok: true, id: dest.id });
});

app.put("/api/destinations/:id", requireAuth, requireStreamKey, (req, res) => {
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
    const activePathName = activeFeedPath.get(req.account.twitchUserId);
    if (activePathName) {
      stopDestination(req.account.twitchUserId, dest.id);
      startDestination(req.account, dest, activePathName);
    }
  }
  saveState(state);
  res.json({ ok: true });
});

app.delete("/api/destinations/:id", requireAuth, requireStreamKey, (req, res) => {
  const dest = findDestination(req.account, req.params.id);
  if (!dest) return res.status(404).json({ error: "unknown destination" });
  stopDestination(req.account.twitchUserId, dest.id);
  req.account.destinations = req.account.destinations.filter(d => d.id !== dest.id);
  saveState(state);
  res.json({ ok: true });
});

app.post("/api/destinations/:id/toggle", requireAuth, requireStreamKey, (req, res) => {
  const dest = findDestination(req.account, req.params.id);
  if (!dest) return res.status(404).json({ error: "unknown destination" });

  dest.enabled = Boolean(req.body?.enabled);
  saveState(state);

  const activePathName = activeFeedPath.get(req.account.twitchUserId);
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
