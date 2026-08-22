const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const express = require("express");
const session = require("express-session");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { createOverlayRouter, resolveSceneFragment, withWidgets } = require("./overlays");
const events = require("./events");
const musicEngine = require("./music-engine");
const { Compositor } = require("./compositor");
const { createProfileMusicService } = require("./profile-music");
const { createProfileVodService } = require("./profile-vod");
const { createTwitchApi } = require("./twitch-api");
const { createMediaMtxRecordings } = require("./mediamtx-recordings");
const { createYoutubeUploadService } = require("./youtube-upload");
const { createHostedOauth } = require("./hosted-oauth");
const { homePage, loginPage, privacyPage, termsPage } = require("./site-pages");
const profileRtmp = require("./profile-rtmp");
const gpuEncoder = require("./gpu-encoder");
const { OUTPUT_LAYOUTS, normaliseLayout, destinationFfmpegArgs } = require("./destination-output");

const PORT = Number(process.env.DASHBOARD_PORT || 8090);
const MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
const MEDIAMTX_PLAYBACK = process.env.MEDIAMTX_PLAYBACK || "http://127.0.0.1:9996";
const MEDIA_HOST = process.env.PI_IP || "127.0.0.1";
const CONSOLE_APP = process.env.CONSOLE_APP || "app";
const PC_APP = process.env.PC_APP || "live";
const RELAY_APP = process.env.RELAY_APP || "relay";
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "data", "state.json");
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(path.dirname(STATE_FILE), "music");
const VOD_DIR = process.env.VOD_DIR || path.join(path.dirname(STATE_FILE), "vod");
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(path.dirname(STATE_FILE), "recordings");
const MUSIC_MAX_BYTES = Number(process.env.MUSIC_MAX_MB || 50) * 1024 * 1024;
const VOD_MAX_BYTES = Number(process.env.VOD_MAX_GB || 20) * 1024 * 1024 * 1024;
const POLL_MS = 1500;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 60 * 60 * 1000);
const DASHBOARD_ORIGIN = `http://127.0.0.1:${PORT}`;
const RTMP_ORIGIN = process.env.MEDIA_RTMP_ORIGIN || "rtmp://127.0.0.1:1935";

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";
const TWITCH_REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || `http://${MEDIA_HOST}:${PORT}/auth/twitch/callback`;
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || "";
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || "";
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || `http://${MEDIA_HOST}:${PORT}/auth/youtube/callback`;
const OAUTH_BROKER_URL = process.env.CASTNEXUS_OAUTH_BROKER_URL || "";
const hostedOauth = createHostedOauth({ brokerUrl:OAUTH_BROKER_URL });

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (loaded.destinations && !loaded.accounts) return { accounts:{}, pendingLegacyDestinations:loaded.destinations, sessionSecret:crypto.randomBytes(32).toString("hex") };
    if (!loaded.sessionSecret) loaded.sessionSecret = crypto.randomBytes(32).toString("hex");
    if (!loaded.accounts) loaded.accounts = {};
    return loaded;
  }
  const initial = { accounts:{}, pendingLegacyDestinations:null, sessionSecret:crypto.randomBytes(32).toString("hex") };
  saveState(initial);
  return initial;
}
function saveState(nextState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive:true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
}
const state = loadState();

function generatePcKey() { return crypto.randomBytes(12).toString("hex"); }
function defaultOverlayConfig() {
  return {
    startingSoon:{ title:"Starting Soon", subtitle:"Stream begins shortly", accent:"#7c5cff" },
    brb:{ title:"BRB", subtitle:"Be right back", accent:"#8a2bff" },
    ending:{ title:"Thanks for watching", subtitle:"Stream over", accent:"#ff2bd6" },
    live:{ title:"LIVE", accent:"#35d07f" },
    nowPlaying:{ enabled:false, corner:"br" },
  };
}
function defaultMusicSettings() { return { shuffle:false, loop:true, volume:0.7 }; }

function getAccount(id) {
  if (!id) return undefined;
  const account = state.accounts[id];
  if (!account) return account;
  let dirty = false;
  if (!account.pcKey) { account.pcKey = generatePcKey(); dirty = true; }
  if (!account.destinations) { account.destinations = []; dirty = true; }
  if (!account.overlayConfig) { account.overlayConfig = defaultOverlayConfig(); dirty = true; }
  if (!account.overlayConfig.nowPlaying) { account.overlayConfig.nowPlaying = { enabled:false, corner:"br" }; dirty = true; }
  if (!account.overlays) { account.overlays = []; dirty = true; }
  if (!Array.isArray(account.musicTracks)) { account.musicTracks = []; dirty = true; }
  if (!account.musicSettings) { account.musicSettings = defaultMusicSettings(); dirty = true; }
  if (!account.musicProfiles || typeof account.musicProfiles !== "object" || Array.isArray(account.musicProfiles)) { account.musicProfiles = {}; dirty = true; }
  if (!account.vodProfiles || typeof account.vodProfiles !== "object" || Array.isArray(account.vodProfiles)) { account.vodProfiles = {}; dirty = true; }
  if (account.currentScene === undefined) { account.currentScene = null; dirty = true; }
  if (account.compositorEnabled === undefined) { account.compositorEnabled = false; dirty = true; }
  if (account.recordingEnabled === undefined) { account.recordingEnabled = false; dirty = true; }
  if (!Array.isArray(account.youtubeUploadHistory)) { account.youtubeUploadHistory = []; dirty = true; }
  for (const dest of account.destinations) {
    const layout = normaliseLayout(dest.layout);
    if (dest.layout !== layout) { dest.layout = layout; dirty = true; }
  }
  if (profileRtmp.ensureProfileRtmpKeys(account, { legacyKey:account.pcKey })) dirty = true;
  if (dirty) saveState(state);
  return account;
}
function getAccountByLogin(login) {
  const account = Object.values(state.accounts).find(a => a.twitchLogin === login);
  return account ? getAccount(account.twitchUserId) : null;
}

const twitchApi = createTwitchApi({ clientId:TWITCH_CLIENT_ID, clientSecret:TWITCH_CLIENT_SECRET, hostedOauth });
const recordings = createMediaMtxRecordings({ apiBase:MEDIAMTX_API, playbackBase:MEDIAMTX_PLAYBACK, recordingsDir:RECORDINGS_DIR, state, saveState });
const youtubeUploads = createYoutubeUploadService({ clientId:YOUTUBE_CLIENT_ID, clientSecret:YOUTUBE_CLIENT_SECRET, redirectUri:YOUTUBE_REDIRECT_URI, state, saveState, recordings, hostedOauth });
const profileMusic = createProfileMusicService({ state, saveState, musicDir:MUSIC_DIR, maxBytes:MUSIC_MAX_BYTES, musicEngine, events });
const profileVod = createProfileVodService({ state, saveState, vodDir:VOD_DIR, maxBytes:VOD_MAX_BYTES, probeDurationSeconds:musicEngine.probeDurationSeconds, rtmpOrigin:RTMP_ORIGIN, twitchApi });

function findDestination(account, id) { return account.destinations.find(d => d.id === id); }
function normaliseDestinationPlatform(value) { const platform=String(value||"custom-rtmp").toLowerCase();return /^[a-z0-9-]{1,40}$/.test(platform)?platform:"custom-rtmp"; }
function maskSecret(value) { if (!value || value.length <= 8) return "••••••••"; return value.slice(0,4) + "••••" + value.slice(-4); }
function maskUrl(url) { if (!url || url.length <= 12) return "••••••••"; return url.slice(0,18) + "••••" + url.slice(-4); }
function safePathFor(account) { return `public/${account.twitchLogin || account.twitchUserId}`; }

const activeDestinations = new Map();
const activeRepublish = new Map();
const liveSessions = new Map();
const activeFeedPath = new Map();
const graceState = new Map();
const compositors = new Map();
const youtubeUploadJobs = new Map();

function activeProfile(account) { return profileRtmp.activeProfileFor(account); }
function compositedPathFor(accountId) { return `composited/${accountId}`; }
function destinationSourcePathFor(account) {
  const pathName = activeFeedPath.get(account.twitchUserId);
  if (!pathName) return null;
  return account.compositorEnabled ? compositedPathFor(account.twitchUserId) : pathName;
}
function compositorFor(account) {
  let compositor = compositors.get(account.twitchUserId);
  if (!compositor) {
    compositor = new Compositor({
      accountId:account.twitchUserId,
      pageUrl:`${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(account.twitchLogin)}/compositor`,
      audioSourceUrl:`rtmp://127.0.0.1:1935/${safePathFor(account)}`,
      outputUrl:`rtmp://127.0.0.1:1935/${compositedPathFor(account.twitchUserId)}`,
      getMusicNow:() => profileMusic.getNow(getAccount(account.twitchUserId), null, { respectScene:true }),
      musicFilePathFor:(trackId) => {
        const acc = getAccount(account.twitchUserId);
        const profile = profileMusic.activeProfileFor(acc);
        return profile ? profileMusic.filePathFor(acc, profile.id, trackId) : null;
      },
    });
    compositors.set(account.twitchUserId, compositor);
  }
  return compositor;
}
function startCompositorFor(account) { if (account.compositorEnabled) compositorFor(account).start(); }
function stopCompositorFor(accountId) { const compositor = compositors.get(accountId); if (compositor) compositor.stop(); }

const DESTINATION_URL_RE = /^(rtmps?|srt):\/\/.+/i;
const DESTINATION_URL_HINT = "a valid rtmp://, rtmps://, or srt:// url is required";
function startDestination(account, dest, pathName, { forceCpu = false } = {}) {
  const key = `${account.twitchUserId}:${dest.id}`;
  if (activeDestinations.has(key) || !dest.enabled || !pathName) return;
  const source = `rtmp://127.0.0.1:1935/${pathName}`;
  const started = Date.now();
  const child = spawn("ffmpeg", destinationFfmpegArgs(source, dest, { forceCpu }));
  child.stderr.on("data", () => {});
  child.on("exit", code => {
    activeDestinations.delete(key);
    const stillWanted = findDestination(account, dest.id)?.enabled;
    const stillSource = destinationSourcePathFor(account) === pathName;
    const selected = gpuEncoder.status().selected;
    if (code !== 0 && !forceCpu && selected.hardware && normaliseLayout(dest.layout) !== "source" && Date.now() - started < 8000 && stillWanted && stillSource) {
      console.warn(`[dashboard] ${account.twitchLogin}/${dest.name} ${selected.label} failed quickly - falling back to CPU x264`);
      return setTimeout(() => startDestination(account, findDestination(account, dest.id) || dest, pathName, { forceCpu:true }), 500);
    }
    if (code !== 0) console.log(`[dashboard] ${account.twitchLogin}/${dest.name} push exited (code ${code})`);
    if (stillSource && stillWanted) setTimeout(() => { if (destinationSourcePathFor(account) === pathName) startDestination(account, findDestination(account, dest.id) || dest, pathName, { forceCpu }); }, 2000);
  });
  activeDestinations.set(key, child);
  console.log(`[dashboard] started push -> ${account.twitchLogin}/${dest.name} (${normaliseLayout(dest.layout)}, ${forceCpu ? "CPU fallback" : gpuEncoder.status().selected.label})`);
}
function stopDestination(accountId, destId) {
  const key = `${accountId}:${destId}`, child = activeDestinations.get(key);
  if (!child) return;
  child.removeAllListeners("exit"); child.kill("SIGTERM"); activeDestinations.delete(key);
}
function stopAllDestinationsFor(accountId) {
  for (const key of [...activeDestinations.keys()]) if (key.startsWith(`${accountId}:`)) stopDestination(accountId, key.split(":")[1]);
}
function startRepublish(account, pathName) {
  if (activeRepublish.has(account.twitchUserId)) return;
  const source = `rtmp://127.0.0.1:1935/${pathName}`;
  const dest = `rtmp://127.0.0.1:1935/${safePathFor(account)}`;
  const child = spawn("ffmpeg", ["-hide_banner","-loglevel","warning","-i",source,"-map","0:v:0","-map","0:a:0?","-c:v","copy","-c:a","copy","-f","flv",dest]);
  child.stderr.on("data", () => {});
  child.on("exit", code => {
    activeRepublish.delete(account.twitchUserId);
    if (code !== 0) console.log(`[dashboard] ${account.twitchLogin} public republish exited (code ${code})`);
    if (activeFeedPath.get(account.twitchUserId) === pathName) setTimeout(() => { if (activeFeedPath.get(account.twitchUserId) === pathName) startRepublish(account, pathName); }, 2000);
  });
  activeRepublish.set(account.twitchUserId, child);
  console.log(`[dashboard] ${account.twitchLogin} public republish -> ${safePathFor(account)}`);
}
function stopRepublish(accountId) {
  const child = activeRepublish.get(accountId);
  if (!child) return;
  child.removeAllListeners("exit"); child.kill("SIGTERM"); activeRepublish.delete(accountId);
}

function matchAccountForPath(pathName) {
  for (const raw of Object.values(state.accounts)) {
    const account = getAccount(raw.twitchUserId);
    const match = profileRtmp.matchProfilePath(account, pathName);
    if (match) return { account, profileId:match.profile.id, source:match.app === RELAY_APP ? "rerun" : profileRtmp.sourceForProfile(match.profile) };
  }
  const parts = String(pathName).split("/");
  const appName = parts[0], key = parts[parts.length - 1];
  if (appName === PC_APP) {
    const raw = Object.values(state.accounts).find(a => a.pcKey && a.pcKey === key);
    if (!raw) return null;
    const account = getAccount(raw.twitchUserId);
    const profile = profileRtmp.profileById(account, account.legacyPcProfileId);
    if (!profile) return null;
    return { account, profileId:profile.id, source:profileRtmp.sourceForProfile(profile), legacy:true };
  }
  if (appName === RELAY_APP && parts.length === 2) {
    const raw = Object.values(state.accounts).find(a => a.pcKey && a.pcKey === key);
    if (!raw) return null;
    const account = getAccount(raw.twitchUserId);
    const profileId = profileVod.publicStatus(account.twitchUserId)?.profileId;
    const profile = profileRtmp.profileById(account, profileId) || activeProfile(account);
    if (!profile) return null;
    return { account, profileId:profile.id, source:"rerun", legacy:true };
  }
  const raw = Object.values(state.accounts).find(a => a.streamKey && a.streamKey === key);
  if (!raw) return null;
  const account = getAccount(raw.twitchUserId);
  const profile = activeProfile(account);
  if (!profile || profile.mode !== "console") return null;
  if (appName !== CONSOLE_APP) console.log(`[dashboard] note: ${account.twitchLogin} stream matched under app "${appName}" (expected "${CONSOLE_APP}") - treating as console`);
  return { account, profileId:profile.id, source:"console", legacy:true };
}
function activeSessionFor(accountId) {
  const activePath = activeFeedPath.get(accountId);
  return activePath ? liveSessions.get(activePath) || null : null;
}
function activeSourceFor(accountId) { return activeSessionFor(accountId)?.source || null; }
function stopOutputsFor(accountId) { activeFeedPath.delete(accountId); stopAllDestinationsFor(accountId); stopRepublish(accountId); stopCompositorFor(accountId); }
function startOutputsFor(account, pathName) {
  const sourceSession = liveSessions.get(pathName);
  activeFeedPath.set(account.twitchUserId, pathName);
  startRepublish(account, pathName);
  if (account.compositorEnabled) startCompositorFor(account);
  const source = destinationSourcePathFor(account);
  for (const dest of account.destinations) if (dest.enabled) startDestination(account, dest, source);
  console.log(`[dashboard] ${account.twitchLogin} routed ${sourceSession?.source || "source"} for profile ${sourceSession?.profileId || "legacy"}`);
}
function clearGrace(accountId) { const grace = graceState.get(accountId); if (!grace) return; clearTimeout(grace.timer); graceState.delete(accountId); }
function enterGrace(account, pathName, source, profileId) {
  const previous = graceState.get(account.twitchUserId);
  if (previous?.profileId === profileId) return;
  if (previous) clearGrace(account.twitchUserId);
  const deadline = Date.now() + RECONNECT_GRACE_MS;
  console.log(`[dashboard] ${account.twitchLogin} ${source} disconnected for profile ${profileId} - waiting up to ${Math.round(RECONNECT_GRACE_MS/60000)}m`);
  const timer = setTimeout(() => {
    graceState.delete(account.twitchUserId);
    const selected = activeProfile(account);
    if (selected?.id === profileId) stopOutputsFor(account.twitchUserId);
  }, RECONNECT_GRACE_MS);
  graceState.set(account.twitchUserId, { timer, deadline, pathName, source, profileId });
}
function candidateForProfile(accountId, profile) {
  const rows = [...liveSessions.entries()].filter(([,s]) => s.accountId === accountId && s.profileId === profile?.id);
  if (!rows.length) return null;
  if (profile?.mode === "music") return rows.find(([,s]) => s.source === "music") || rows[0];
  return rows.find(([,s]) => s.source === "pc" || s.source === "console") || rows[0];
}
function reconcileSelectedProfile(account) {
  const selected = activeProfile(account);
  if (!selected) return;
  const activePath = activeFeedPath.get(account.twitchUserId);
  const current = activePath ? liveSessions.get(activePath) : null;
  if (activePath && (!current || current.profileId !== selected.id)) {
    clearGrace(account.twitchUserId);
    stopOutputsFor(account.twitchUserId);
  }
  if (!activeFeedPath.has(account.twitchUserId)) {
    const candidate = candidateForProfile(account.twitchUserId, selected);
    if (candidate) {
      const [pathName] = candidate;
      clearGrace(account.twitchUserId);
      startOutputsFor(account, pathName);
    }
  }
}

async function pollLive() {
  let readyPaths;
  try {
    const response = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
    const data = await response.json();
    readyPaths = new Set((data.items || []).filter(item => item.ready).map(item => item.name));
  } catch { readyPaths = new Set(); }
  for (const [pathName, live] of [...liveSessions.entries()]) {
    if (readyPaths.has(pathName)) continue;
    liveSessions.delete(pathName);
    console.log(`[dashboard] ${live.accountId} ${live.source} stream stopped for profile ${live.profileId}`);
    if (activeFeedPath.get(live.accountId) !== pathName) continue;
    const account = getAccount(live.accountId);
    const selected = account ? activeProfile(account) : null;
    if (!account || selected?.id !== live.profileId) { clearGrace(live.accountId); stopOutputsFor(live.accountId); continue; }
    const other = [...liveSessions.entries()].find(([,s]) => s.accountId === live.accountId && s.profileId === live.profileId);
    if (other) {
      const [otherPath] = other;
      stopOutputsFor(live.accountId);
      startOutputsFor(account, otherPath);
      continue;
    }
    if (live.source === "rerun") {
      const rerunState = profileVod.publicStatus(live.accountId)?.state;
      if (!["starting","playing","restarting"].includes(rerunState)) {
        clearGrace(live.accountId); stopOutputsFor(live.accountId); continue;
      }
    }
    enterGrace(account, pathName, live.source, live.profileId);
  }
  for (const pathName of readyPaths) {
    if (liveSessions.has(pathName)) continue;
    const matched = matchAccountForPath(pathName);
    if (!matched) continue;
    const { account, source, profileId } = matched;
    liveSessions.set(pathName, { accountId:account.twitchUserId, profileId, source });
    const selected = activeProfile(account);
    console.log(`[dashboard] ${account.twitchLogin} ${source} is live for profile ${profileId}${selected?.id === profileId ? " (selected)" : " (standby)"}`);
    if (selected?.id !== profileId) continue;
    const grace = graceState.get(account.twitchUserId);
    const wasInGrace = grace?.profileId === profileId;
    if (wasInGrace) clearGrace(account.twitchUserId);
    const currentActive = activeFeedPath.get(account.twitchUserId);
    if (currentActive === pathName) continue;
    if (currentActive && !wasInGrace) continue;
    if (currentActive && wasInGrace) stopOutputsFor(account.twitchUserId);
    startOutputsFor(account, pathName);
  }
  for (const raw of Object.values(state.accounts)) reconcileSelectedProfile(getAccount(raw.twitchUserId));
}
setInterval(pollLive, POLL_MS);

const app = express();
app.set("trust proxy", 1);
function fixRedirectPrefix(prefix) { return proxyRes => { const location = proxyRes.headers.location; if (location && location.startsWith("/")) proxyRes.headers.location = prefix + location; }; }

const setupRoutes = require("./setup-routes");
app.use("/setup", setupRoutes);

app.use("/hls", createProxyMiddleware({ target:"http://127.0.0.1:8888", changeOrigin:true, pathRewrite:{ "^/hls":"" }, ws:true, onProxyRes:fixRedirectPrefix("/hls") }));
app.use("/webrtc", createProxyMiddleware({ target:"http://127.0.0.1:8889", changeOrigin:true, pathRewrite:{ "^/webrtc":"" }, ws:true, onProxyRes:fixRedirectPrefix("/webrtc") }));
app.use("/overlay", createOverlayRouter({
  getAccountByLogin, musicDir:MUSIC_DIR,
  isLiveFn:account => !!activeSourceFor(account.twitchUserId),
  subscribeEvents:events.subscribe,
  getMusicNow:(account, profileId, options) => profileMusic.getNow(account, profileId, options),
  getMusicState:(account, profileId) => profileMusic.bucketFor(account, profileId, { create:false }),
  getActiveProfile:account => profileMusic.activeProfileFor(account),
  musicFilePathFor:(account, profileId, trackId) => profileMusic.filePathFor(account, profileId, trackId),
}));
app.use(express.json());
app.use(session({ secret:state.sessionSecret, resave:false, saveUninitialized:false, cookie:{ httpOnly:true, sameSite:"lax", secure:"auto" } }));
function requireAuth(req,res,next){const account=getAccount(req.session.accountId);if(!account)return res.status(401).json({error:"not authenticated"});req.account=account;next();}
const STUDIO_HTML = path.join(__dirname,"public","index.html");
function siteHeaders(res){res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");}
function sendPublicPage(res,html){siteHeaders(res);res.setHeader("Cache-Control","public, max-age=300");res.type("html").send(html);}
app.get("/",(_req,res)=>sendPublicPage(res,homePage()));
app.get("/privacy",(_req,res)=>sendPublicPage(res,privacyPage()));
app.get("/terms",(_req,res)=>sendPublicPage(res,termsPage()));
app.get("/login",(req,res)=>{if(getAccount(req.session.accountId))return res.redirect("/dashboard");sendPublicPage(res,loginPage());});
app.get("/dashboard",(req,res)=>{if(!getAccount(req.session.accountId))return res.redirect("/login");siteHeaders(res);res.setHeader("Cache-Control","no-store");res.sendFile(STUDIO_HTML);});
const SOURCE_MODES=["console","pc","both"];
function needsStreamKeyFor(account){return (account.sourceMode==="console"||account.sourceMode==="both")&&!account.streamKey;}
function requireOnboarded(req,res,next){if(!req.account.sourceMode)return res.status(403).json({error:"pick a source mode first"});if(needsStreamKeyFor(req.account))return res.status(403).json({error:"must set stream key"});next();}

function loginTwitchUser(req, twitchUser) {
  let account=state.accounts[twitchUser.id];const isNewAccount=!account;
  if(!account){account={twitchUserId:twitchUser.id,streamKey:null,pcKey:generatePcKey(),sourceMode:null,destinations:state.pendingLegacyDestinations||[],overlayConfig:defaultOverlayConfig(),overlays:[],musicTracks:[],musicSettings:defaultMusicSettings(),musicProfiles:{},vodProfiles:{},currentScene:null,compositorEnabled:false,recordingEnabled:false,youtubeUploadHistory:[],createdAt:new Date().toISOString()};state.accounts[twitchUser.id]=account;if(state.pendingLegacyDestinations){state.pendingLegacyDestinations=null;}}
  account.twitchLogin=twitchUser.login;account.displayName=twitchUser.displayName||twitchUser.display_name;account.profileImageUrl=twitchUser.profileImageUrl||twitchUser.profile_image_url;saveState(state);req.session.accountId=twitchUser.id;
  recordings.ensureConfig(account).catch(err=>console.warn(`[recordings] path config: ${err.message}`));profileVod.refreshTwitchCatalog(account).catch(err=>console.warn(`[twitch-vods] initial refresh: ${err.message}`));
  console.log(`[dashboard] ${isNewAccount?"registered":"logged in"}: ${twitchUser.login}`);
  return account;
}
function hostedWaitPage(provider, authorizationUrl) {
  const label=provider==="youtube"?"YouTube":"Twitch";
  const safeUrl=JSON.stringify(authorizationUrl);
  return `<!doctype html><meta charset="utf-8"><title>Connect ${label}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a12;color:#f4f6ff;font:16px system-ui}.card{max-width:560px;padding:38px;border:1px solid #292d3b;border-radius:24px;background:#10131f;text-align:center}p{color:#adb5ca;line-height:1.6}.spin{width:34px;height:34px;margin:20px auto;border:3px solid #292d3b;border-top-color:#7c5cff;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}button{padding:12px 18px;border:0;border-radius:10px;background:#7c5cff;color:white;font-weight:700}</style><div class="card"><h1>Connect ${label}</h1><p id="message">Complete authorization in the secure browser window. This page will finish automatically.</p><div class="spin"></div><button id="open">Open authorization</button></div><script>const auth=${safeUrl};let opened=false;function openAuth(){opened=true;window.open(auth,"_blank","noopener");}document.getElementById("open").onclick=openAuth;openAuth();async function poll(){try{const r=await fetch("/auth/hosted/${provider}/status",{cache:"no-store"});const d=await r.json();if(r.status===202)return setTimeout(poll,1200);if(!r.ok)throw new Error(d.error||"Authorization failed");location.href=d.redirect||"/";}catch(e){document.getElementById("message").textContent=e.message;document.querySelector(".spin").style.display="none";}}setTimeout(poll,1000);</script>`;
}
async function beginHostedOauth(req,res,provider){
  try{const flow=await hostedOauth.start(provider);req.session.hostedOauth=flow;res.send(hostedWaitPage(provider,flow.authorizationUrl));}
  catch(err){res.status(err.status||502).send(`Hosted ${provider} authorization is unavailable: ${err.message}`);}
}
app.get("/auth/hosted/:provider/status",async(req,res)=>{
  const provider=String(req.params.provider||"");const flow=req.session.hostedOauth;
  if(!flow||flow.provider!==provider)return res.status(404).json({error:"authorization request not found"});
  if(Date.now()>flow.expiresAt){delete req.session.hostedOauth;return res.status(410).json({error:"authorization request expired"});}
  try{const result=await hostedOauth.exchange(flow);if(result.pending)return res.status(202).json({status:"pending"});delete req.session.hostedOauth;
    if(provider==="twitch"){const account=loginTwitchUser(req,result.result.user);account.oauthBrokerToken=result.result.brokerToken;saveState(state);return res.json({ok:true,redirect:"/dashboard"});}
    const account=getAccount(req.session.accountId);if(!account)return res.status(401).json({error:"Sign in with Twitch first"});youtubeUploads.storeTokens(account,result.result);res.json({ok:true,redirect:"/dashboard?youtube=connected"});
  }catch(err){delete req.session.hostedOauth;res.status(err.status||400).json({error:err.message});}
});

app.get("/auth/twitch",(req,res)=>{
  if(hostedOauth.enabled())return beginHostedOauth(req,res,"twitch");
  if(!TWITCH_CLIENT_ID)return res.status(500).send("TWITCH_CLIENT_ID is not configured");
  const oauthState=crypto.randomBytes(16).toString("hex");req.session.oauthState=oauthState;
  const url=new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("client_id",TWITCH_CLIENT_ID);url.searchParams.set("redirect_uri",TWITCH_REDIRECT_URI);url.searchParams.set("response_type","code");url.searchParams.set("scope","");url.searchParams.set("state",oauthState);res.redirect(url.toString());
});
app.get("/auth/twitch/callback",async(req,res)=>{
  const{code,state:returnedState,error,error_description}=req.query;
  if(error)return res.status(400).send(`Twitch login failed: ${error_description||error}`);
  if(!code||!returnedState||returnedState!==req.session.oauthState)return res.status(400).send("Invalid OAuth state - please try logging in again");
  delete req.session.oauthState;
  try{
    const tokenRes=await fetch("https://id.twitch.tv/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:TWITCH_CLIENT_ID,client_secret:TWITCH_CLIENT_SECRET,code,grant_type:"authorization_code",redirect_uri:TWITCH_REDIRECT_URI})});
    const tokenData=await tokenRes.json();if(!tokenRes.ok)throw new Error(tokenData.message||"token exchange failed");
    const userRes=await fetch("https://api.twitch.tv/helix/users",{headers:{Authorization:`Bearer ${tokenData.access_token}`,"Client-Id":TWITCH_CLIENT_ID}});const userData=await userRes.json();if(!userRes.ok||!userData.data?.[0])throw new Error("failed to fetch Twitch user info");
    loginTwitchUser(req,userData.data[0]);res.redirect("/dashboard");
  }catch(err){console.error("[dashboard] Twitch OAuth error:",err.message);res.status(500).send("Twitch login failed - please try again");}
});
app.get("/auth/youtube",requireAuth,(req,res)=>{if(hostedOauth.enabled())return beginHostedOauth(req,res,"youtube");if(!youtubeUploads.configured())return res.status(500).send("YouTube OAuth is not configured");const oauthState=crypto.randomBytes(24).toString("hex");req.session.youtubeOauthState=oauthState;const url=new URL("https://accounts.google.com/o/oauth2/v2/auth");url.searchParams.set("client_id",YOUTUBE_CLIENT_ID);url.searchParams.set("redirect_uri",YOUTUBE_REDIRECT_URI);url.searchParams.set("response_type","code");url.searchParams.set("scope","https://www.googleapis.com/auth/youtube.upload");url.searchParams.set("access_type","offline");url.searchParams.set("prompt","consent");url.searchParams.set("include_granted_scopes","true");url.searchParams.set("state",oauthState);res.redirect(url.toString());});
app.get("/auth/youtube/callback",async(req,res)=>{const account=getAccount(req.session.accountId);if(!account)return res.status(401).send("Sign in to CastNexus with Twitch first");const{code,state:returnedState,error,error_description}=req.query;if(error)return res.status(400).send(`YouTube authorization failed: ${error_description||error}`);if(!code||!returnedState||returnedState!==req.session.youtubeOauthState)return res.status(400).send("Invalid YouTube OAuth state");delete req.session.youtubeOauthState;try{youtubeUploads.storeTokens(account,await youtubeUploads.exchangeCode(String(code)));res.redirect("/dashboard?youtube=connected");}catch(err){res.status(500).send(`YouTube authorization failed: ${err.message}`);}});

app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.post("/api/streamkey",requireAuth,(req,res)=>{const{streamKey}=req.body||{};if(!streamKey||!String(streamKey).trim())return res.status(400).json({error:"stream key is required"});req.account.streamKey=String(streamKey).trim();saveState(state);res.json({ok:true});});
app.post("/api/source-mode",requireAuth,(req,res)=>{const{sourceMode}=req.body||{};if(!SOURCE_MODES.includes(sourceMode))return res.status(400).json({error:"sourceMode must be console, pc, or both"});req.account.sourceMode=sourceMode;saveState(state);res.json({ok:true});});
app.post("/api/pckey/regenerate",requireAuth,(req,res)=>{const profile=activeProfile(req.account);if(!profile)return res.status(404).json({error:"no active profile"});profile.rtmpKey=profileRtmp.generateProfileRtmpKey();saveState(state);for(const[pathName,live]of[...liveSessions.entries()])if(live.accountId===req.account.twitchUserId&&live.profileId===profile.id)liveSessions.delete(pathName);if(activeSessionFor(req.account.twitchUserId)?.profileId===profile.id)stopOutputsFor(req.account.twitchUserId);res.json({ok:true,profileId:profile.id,pcKey:profile.rtmpKey,profileRtmp:profileRtmp.profileRtmpInfo(req.account,MEDIA_HOST,profile.id)});});
app.post("/api/profiles/:profileId/rtmp-key/regenerate",requireAuth,(req,res)=>{const profile=profileRtmp.profileById(req.account,req.params.profileId);if(!profile)return res.status(404).json({error:"unknown profile"});profile.rtmpKey=profileRtmp.generateProfileRtmpKey();saveState(state);for(const[pathName,live]of[...liveSessions.entries()])if(live.accountId===req.account.twitchUserId&&live.profileId===profile.id)liveSessions.delete(pathName);if(activeSessionFor(req.account.twitchUserId)?.profileId===profile.id)stopOutputsFor(req.account.twitchUserId);res.json({ok:true,profileRtmp:profileRtmp.profileRtmpInfo(req.account,MEDIA_HOST,profile.id)});});
app.get("/api/system/encoder",requireAuth,(req,res)=>res.json(gpuEncoder.status()));

app.get("/api/recordings",requireAuth,async(req,res)=>{try{res.json(await recordings.list(req.account));}catch(err){res.status(503).json({error:err.message});}});
app.post("/api/recordings/toggle",requireAuth,async(req,res)=>{try{const enabled=await recordings.setEnabled(req.account,Boolean(req.body?.enabled));res.json({ok:true,enabled,recordings:await recordings.list(req.account)});}catch(err){res.status(503).json({error:err.message});}});
app.delete("/api/recordings/segment",requireAuth,async(req,res)=>{try{res.json({ok:true,recordings:await recordings.deleteSegment(req.account,req.body?.start)});}catch(err){res.status(err.status||400).json({error:err.message});}});
app.delete("/api/recordings/all",requireAuth,async(req,res)=>{try{res.json({ok:true,recordings:await recordings.deleteAll(req.account)});}catch(err){res.status(503).json({error:err.message});}});
app.get("/api/recordings/play",requireAuth,async(req,res)=>{try{const library=await recordings.list(req.account);const segment=library.segments.find(s=>s.start===req.query.start);if(!segment)return res.status(404).send("recording not found");const upstream=await fetch(recordings.playbackUrl(req.account,segment.start,segment.duration,"mp4"));if(!upstream.ok||!upstream.body)return res.status(upstream.status).send("recording playback unavailable");res.setHeader("Content-Type",upstream.headers.get("content-type")||"video/mp4");const len=upstream.headers.get("content-length");if(len)res.setHeader("Content-Length",len);Readable.fromWeb(upstream.body).pipe(res);}catch(err){res.status(500).send(err.message);}});
app.get("/api/youtube/status",requireAuth,(req,res)=>res.json({...youtubeUploads.status(req.account),history:req.account.youtubeUploadHistory.slice(-20).reverse(),jobs:[...youtubeUploadJobs.values()].filter(j=>j.accountId===req.account.twitchUserId).map(({accountId,...j})=>j)}));
app.post("/api/youtube/disconnect",requireAuth,(req,res)=>{youtubeUploads.disconnect(req.account);res.json({ok:true});});
app.post("/api/youtube/upload-recording",requireAuth,async(req,res)=>{try{youtubeUploads.assertQuota(req.account);if(!youtubeUploads.status(req.account).connected)return res.status(409).json({error:"Connect YouTube before uploading a MediaMTX recording"});const library=await recordings.list(req.account);const segment=library.segments.find(s=>s.start===req.body?.start);if(!segment)return res.status(404).json({error:"recording not found"});const jobId=crypto.randomUUID();const job={id:jobId,accountId:req.account.twitchUserId,state:"queued",start:segment.start,title:String(req.body?.title||`CastNexus recording ${segment.start}`),createdAt:new Date().toISOString(),error:null,result:null};youtubeUploadJobs.set(jobId,job);res.status(202).json({ok:true,jobId});setImmediate(async()=>{try{job.state="uploading";const result=await youtubeUploads.uploadRecording(req.account,segment,{title:job.title,description:String(req.body?.description||""),privacyStatus:String(req.body?.privacyStatus||"private"),categoryId:String(req.body?.categoryId||"20"),tags:Array.isArray(req.body?.tags)?req.body.tags:String(req.body?.tags||"").split(",").map(x=>x.trim()).filter(Boolean)});job.state="completed";job.result={id:result.id,url:result.url,privacyStatus:result.privacyStatus};job.completedAt=new Date().toISOString();req.account.youtubeUploadHistory.push({jobId,start:segment.start,title:job.title,...job.result,completedAt:job.completedAt});req.account.youtubeUploadHistory=req.account.youtubeUploadHistory.slice(-100);saveState(state);}catch(err){job.state="error";job.error=err.message;job.completedAt=new Date().toISOString();}});}catch(err){res.status(err.code==="YOUTUBE_NOT_WHITELISTED"?403:err.code==="YOUTUBE_SOFT_QUOTA"?429:400).json({error:err.message,code:err.code||"YOUTUBE_UPLOAD_FAILED"});}});

app.get("/api/overlays/config",requireAuth,(req,res)=>res.json(req.account.overlayConfig));
app.post("/api/overlays/config",requireAuth,(req,res)=>{const body=req.body||{},cfg=req.account.overlayConfig;for(const key of["startingSoon","brb","ending","live","nowPlaying"])if(body[key]&&typeof body[key]==="object")cfg[key]={...cfg[key],...body[key]};saveState(state);res.json({ok:true,overlayConfig:cfg});});
const OVERLAY_TYPES=["html","text","music"];
function slugify(name){return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"overlay";}
function uniqueSlug(account,base,ignoreId){let slug=base,n=2;while(account.overlays.some(o=>o.slug===slug&&o.id!==ignoreId))slug=`${base}-${n++}`;return slug;}
function ensureAccountProfileKeys(account){if(profileRtmp.ensureProfileRtmpKeys(account,{legacyKey:account.pcKey}))saveState(state);}
app.get("/api/overlays",requireAuth,(req,res)=>{ensureAccountProfileKeys(req.account);res.json({overlays:req.account.overlays});});
app.post("/api/overlays",requireAuth,(req,res)=>{const{name,type,config}=req.body||{};if(!name||!String(name).trim())return res.status(400).json({error:"name is required"});if(!OVERLAY_TYPES.includes(type))return res.status(400).json({error:`type must be one of ${OVERLAY_TYPES.join(", ")}`});const overlay={id:crypto.randomUUID(),name:String(name).trim(),slug:uniqueSlug(req.account,slugify(name)),type,config:config&&typeof config==="object"?config:{},createdAt:new Date().toISOString()};req.account.overlays.push(overlay);ensureAccountProfileKeys(req.account);saveState(state);res.json({ok:true,overlay});});
app.put("/api/overlays/:id",requireAuth,(req,res)=>{const overlay=req.account.overlays.find(o=>o.id===req.params.id);if(!overlay)return res.status(404).json({error:"unknown overlay"});const{name,config}=req.body||{};if(name!==undefined){if(!String(name).trim())return res.status(400).json({error:"name cannot be empty"});overlay.name=String(name).trim();overlay.slug=uniqueSlug(req.account,slugify(overlay.name),overlay.id);}if(config!==undefined&&typeof config==="object")overlay.config={...overlay.config,...config};overlay.updatedAt=new Date().toISOString();ensureAccountProfileKeys(req.account);saveState(state);res.json({ok:true,overlay});});
app.delete("/api/overlays/:id",requireAuth,(req,res)=>{const before=req.account.overlays.length;req.account.overlays=req.account.overlays.filter(o=>o.id!==req.params.id);if(before===req.account.overlays.length)return res.status(404).json({error:"unknown overlay"});saveState(state);res.json({ok:true});});

app.use("/api/music",requireAuth,profileMusic.createApiRouter());
app.use("/api/vod",requireAuth,profileVod.createApiRouter());
const SCENE_KINDS=["none","builtin","custom"],BUILTIN_SCENE_NAMES=["startingSoon","brb","ending"];
app.get("/api/scenes/current",requireAuth,(req,res)=>res.json({currentScene:req.account.currentScene}));
app.post("/api/scenes/current",requireAuth,(req,res)=>{const{kind,name,overlayId}=req.body||{};if(!SCENE_KINDS.includes(kind))return res.status(400).json({error:`kind must be one of ${SCENE_KINDS.join(", ")}`});let scene=null;if(kind==="builtin"){if(!BUILTIN_SCENE_NAMES.includes(name))return res.status(400).json({error:`name must be one of ${BUILTIN_SCENE_NAMES.join(", ")}`});scene={kind,name};if(name==="startingSoon"){const minutes=Number(req.account.overlayConfig?.startingSoon?.countdownMinutes||0);if(Number.isFinite(minutes)&&minutes>0)scene.countdownAt=new Date(Date.now()+minutes*60000).toISOString();}}else if(kind==="custom"){const overlay=req.account.overlays.find(o=>o.id===overlayId&&(o.type==="text"||o.type==="html"||o.type==="music"));if(!overlay)return res.status(404).json({error:"unknown overlay"});scene={kind,overlayId};}req.account.currentScene=scene;saveState(state);const html=withWidgets(resolveSceneFragment(scene,req.account),req.account.overlayConfig,req.account.twitchLogin);events.publish(req.account.twitchUserId,{type:"scene",html});res.json({ok:true,currentScene:scene});});
app.get("/api/compositor",requireAuth,(req,res)=>res.json({enabled:!!req.account.compositorEnabled}));
app.post("/api/compositor",requireAuth,(req,res)=>{req.account.compositorEnabled=Boolean(req.body?.enabled);saveState(state);const activePath=activeFeedPath.get(req.account.twitchUserId);if(activePath){stopOutputsFor(req.account.twitchUserId);startOutputsFor(req.account,activePath);}res.json({ok:true,enabled:req.account.compositorEnabled});});

function playbackUrlsFor(req,account){if(!activeSourceFor(account.twitchUserId))return null;const safePath=safePathFor(account),encodedPath=safePath.split("/").map(encodeURIComponent).join("/"),base=`${req.protocol}://${req.get("host")}`;return{webPlayer:`${base}/webrtc/${encodedPath}`,whep:`${base}/webrtc/${encodedPath}/whep`,hls:`${base}/hls/${encodedPath}/index.m3u8`,rtsp:`rtsp://${req.hostname}:8554/${safePath}`,srt:`srt://${req.hostname}:8890?streamid=read:${safePath}`};}
function sourcesStatusFor(account){const selected=activeProfile(account);const sources={console:{enabled:selected?.mode==="console",live:false},pc:{enabled:selected?.mode==="pc",live:false},music:{enabled:selected?.mode==="music",live:false},rerun:{enabled:selected?.mode!=="console",live:false}};const connectedProfiles=[];for(const[pathName,live]of liveSessions.entries()){if(live.accountId!==account.twitchUserId)continue;connectedProfiles.push({profileId:live.profileId,source:live.source,path:pathName,active:activeFeedPath.get(account.twitchUserId)===pathName});if(live.profileId===selected?.id&&sources[live.source])sources[live.source].live=true;}return{sources,activeSource:activeSourceFor(account.twitchUserId),connectedProfiles};}
app.get("/api/status",requireAuth,(req,res)=>{const account=req.account;ensureAccountProfileKeys(account);const selected=activeProfile(account),rtmp=profileRtmp.profileRtmpInfo(account,MEDIA_HOST,selected?.id);const{sources,activeSource,connectedProfiles}=sourcesStatusFor(account);res.json({twitchLogin:account.twitchLogin,displayName:account.displayName,profileImageUrl:account.profileImageUrl,needsSourceMode:!account.sourceMode,needsStreamKey:needsStreamKeyFor(account),streamKeyMasked:account.streamKey?maskSecret(account.streamKey):null,sourceMode:account.sourceMode||null,activeProfileId:selected?.id||null,profileRtmp:rtmp,live:!!activeSource,sources,activeSource,connectedProfiles,rerun:profileVod.publicStatus(account.twitchUserId),recordingEnabled:!!account.recordingEnabled,encoder:gpuEncoder.status(),graceUntil:graceState.get(account.twitchUserId)?.deadline??null,pcServer:rtmp?.server||`rtmp://${MEDIA_HOST}:1935/${PC_APP}`,pcKey:rtmp?.key||account.pcKey,mediaHost:MEDIA_HOST,playback:playbackUrlsFor(req,account),destinations:account.destinations.map(d=>({id:d.id,name:d.name,platform:normaliseDestinationPlatform(d.platform),urlMasked:maskUrl(d.url),layout:normaliseLayout(d.layout),enabled:d.enabled,active:activeDestinations.has(`${account.twitchUserId}:${d.id}`)}))});});
app.post("/api/destinations",requireAuth,requireOnboarded,(req,res)=>{const{name,url,layout,platform}=req.body||{};if(!name||!String(name).trim())return res.status(400).json({error:"name is required"});if(!url||!DESTINATION_URL_RE.test(url))return res.status(400).json({error:DESTINATION_URL_HINT});if(layout!==undefined&&!OUTPUT_LAYOUTS.includes(layout))return res.status(400).json({error:`layout must be one of ${OUTPUT_LAYOUTS.join(", ")}`});const dest={id:crypto.randomUUID(),name:String(name).trim(),platform:normaliseDestinationPlatform(platform),url:String(url).trim(),layout:normaliseLayout(layout),enabled:false};req.account.destinations.push(dest);saveState(state);res.json({ok:true,id:dest.id});});
app.put("/api/destinations/:id",requireAuth,requireOnboarded,(req,res)=>{const dest=findDestination(req.account,req.params.id);if(!dest)return res.status(404).json({error:"unknown destination"});const{name,url,layout}=req.body||{};let restart=false;if(name!==undefined){if(!String(name).trim())return res.status(400).json({error:"name cannot be empty"});dest.name=String(name).trim();}if(url!==undefined){if(!DESTINATION_URL_RE.test(url))return res.status(400).json({error:DESTINATION_URL_HINT});dest.url=String(url).trim();restart=true;}if(layout!==undefined){if(!OUTPUT_LAYOUTS.includes(layout))return res.status(400).json({error:`layout must be one of ${OUTPUT_LAYOUTS.join(", ")}`});if(dest.layout!==layout){dest.layout=layout;restart=true;}}saveState(state);const source=destinationSourcePathFor(req.account);if(restart&&source&&dest.enabled){stopDestination(req.account.twitchUserId,dest.id);startDestination(req.account,dest,source);}res.json({ok:true});});
app.delete("/api/destinations/:id",requireAuth,requireOnboarded,(req,res)=>{const dest=findDestination(req.account,req.params.id);if(!dest)return res.status(404).json({error:"unknown destination"});stopDestination(req.account.twitchUserId,dest.id);req.account.destinations=req.account.destinations.filter(d=>d.id!==dest.id);saveState(state);res.json({ok:true});});
app.post("/api/destinations/:id/toggle",requireAuth,requireOnboarded,(req,res)=>{const dest=findDestination(req.account,req.params.id);if(!dest)return res.status(404).json({error:"unknown destination"});dest.enabled=Boolean(req.body?.enabled);saveState(state);const source=destinationSourcePathFor(req.account);if(source){if(dest.enabled)startDestination(req.account,dest,source);else stopDestination(req.account.twitchUserId,dest.id);}res.json({ok:true});});

app.use(express.static(path.join(__dirname,"public"),{index:false}));
app.listen(PORT,()=>{const encoder=gpuEncoder.status().selected;console.log(`[dashboard] listening on :${PORT}`);console.log(`[dashboard] video encoder: ${encoder.label}${encoder.hardware?" (hardware)":" (software fallback)"}`);if(hostedOauth.enabled())console.log(`[dashboard] hosted OAuth broker: ${hostedOauth.baseUrl}`);if(!hostedOauth.enabled()&&(!TWITCH_CLIENT_ID||!TWITCH_CLIENT_SECRET))console.warn("[dashboard] Twitch OAuth is not configured");if(!hostedOauth.enabled()&&(!YOUTUBE_CLIENT_ID||!YOUTUBE_CLIENT_SECRET))console.warn("[dashboard] YouTube OAuth is not configured");});
