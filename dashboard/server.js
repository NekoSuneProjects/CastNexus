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
const { Compositor, hybridEnabled, useElectronOffscreen } = require("./compositor");
const { createProfileMusicService } = require("./profile-music");
const { createProfileVodService } = require("./profile-vod");
const { createTwitchApi } = require("./twitch-api");
const { createMediaMtxRecordings } = require("./mediamtx-recordings");
const { createYoutubeUploadService } = require("./youtube-upload");
const { createHostedOauth } = require("./hosted-oauth");
const { homePage, loginPage, privacyPage, termsPage } = require("./site-pages");
const profileRtmp = require("./profile-rtmp");
const gpuEncoder = require("./gpu-encoder");
const { OUTPUT_LAYOUTS, OUTPUT_MODES, normaliseLayout, destinationFfmpegArgs, sanitiseOutput, effectiveOutput, planDestination, plannedDestinationArgs, renditionKey, renditionArgs } = require("./destination-output");
const sceneModel = require("./scene-model");
const { resolveProgram } = require("./scene-render");
const { SupervisedProcess, killHard } = require("./process-supervisor");
const captions = require("./captions");
const monitor = require("./resource-monitor");
const performanceModes = require("./performance-modes");
const hardwareProfile = require("./hardware-profile");
const relayPush = require("./relay-push");
const { EncryptedFileSessionStore, accountSessionIsValid } = require("./persistent-session-store");
const { publicBaseUrl, normalisePublicBase, playbackTargets } = require("./public-playback");
const registration = require("./registration");

const PORT = Number(process.env.DASHBOARD_PORT || 8090);
const MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
const MEDIAMTX_PLAYBACK = process.env.MEDIAMTX_PLAYBACK || "http://127.0.0.1:9996";
const MEDIA_HOST = process.env.PI_IP || "127.0.0.1";
const PUBLIC_BASE_URL_ENV = normalisePublicBase(process.env.PUBLIC_BASE_URL) || "";
const PUBLIC_MEDIA_HOST = process.env.PUBLIC_MEDIA_HOST || "";
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
const RECONNECT_IDLE_STOP_MS = Number(process.env.RECONNECT_IDLE_STOP_MS ?? 120000);
const DASHBOARD_ORIGIN = `http://127.0.0.1:${PORT}`;
const RTMP_ORIGIN = process.env.MEDIA_RTMP_ORIGIN || "rtmp://127.0.0.1:1935";

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
  if (!account.relayNodeId) { account.relayNodeId = crypto.randomUUID(); dirty = true; }
  if (account.relayPushEnabled === undefined) { account.relayPushEnabled = false; dirty = true; }
  if (!["rtmp", "whip"].includes(account.relayPushMode)) { account.relayPushMode = "rtmp"; dirty = true; }
  for (const dest of account.destinations) {
    const layout = normaliseLayout(dest.layout);
    if (dest.layout !== layout) { dest.layout = layout; dirty = true; }
  }
  if (profileRtmp.ensureProfileRtmpKeys(account, { legacyKey:account.pcKey })) dirty = true;
  // Overlay Studio scene library (created from defaults on first load; old
  // overlayConfig / currentScene data keeps working through the slots).
  if (sceneModel.ensure(account)) dirty = true;
  if (dirty) saveState(state);
  return account;
}
function getAccountByLogin(login) {
  const account = Object.values(state.accounts).find(a => a.twitchLogin === login);
  return account ? getAccount(account.twitchUserId) : null;
}

const twitchApi = createTwitchApi({ hostedOauth });
const recordings = createMediaMtxRecordings({ apiBase:MEDIAMTX_API, playbackBase:MEDIAMTX_PLAYBACK, recordingsDir:RECORDINGS_DIR, state, saveState });
const youtubeUploads = createYoutubeUploadService({ state, saveState, recordings, hostedOauth });
const profileMusic = createProfileMusicService({ state, saveState, musicDir:MUSIC_DIR, maxBytes:MUSIC_MAX_BYTES, musicEngine, events });
const profileVod = createProfileVodService({ state, saveState, vodDir:VOD_DIR, maxBytes:VOD_MAX_BYTES, probeDurationSeconds:musicEngine.probeDurationSeconds, rtmpOrigin:RTMP_ORIGIN, twitchApi });

function findDestination(account, id) {
  if (id === relayPush.RELAY_DESTINATION_ID) return relayPush.cachedRelayDestination(account);
  return account.destinations.find(d => d.id === id);
}
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
// ---------------------------------------------------------------------------
// Program compositors (Overlay Studio output).
//
// One headless renderer per (orientation, scene) that some enabled
// destination actually consumes. The landscape live program keeps the
// historic composited/<id> MediaMTX path, so existing consumers are
// unaffected; a vertical program exists only while a 9:16 destination needs
// it. Destinations that match a program's size/fps/bitrate stream-copy it,
// so N destinations share ONE browser render + ONE encode.
const PROGRAM_IDLE_STOP_MS = Number(process.env.PROGRAM_IDLE_STOP_MS || 15000);
const programCompositors = new Map(); // key -> { key, accountId, orientation, sceneId, path, compositor, refs:Set, stopTimer }
const renditions = new Map(); // key -> { id, path, supervisor, refs:Set, failed:[], forceCpu }
let lastReadyPaths = new Set();

function safeSeg(value) { return String(value || "x").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80) || "x"; }
function programKey(accountId, orientation, sceneId) { return `${accountId}|${orientation}|${sceneId || "live"}`; }
function programPathFor(accountId, orientation, sceneId) {
  if (orientation === "landscape" && !sceneId) return compositedPathFor(accountId);
  return `program/${safeSeg(accountId)}/${orientation}-${safeSeg(sceneId || "live")}`;
}
// Source stream info (fps/size) per account, probed once each time a source
// goes live so auto programs never render more frames than the source has.
const sourceInfo = new Map(); // accountId -> { info, promise }
function probeSourceFor(account, pathName) {
  const entry = { info:null, promise:null };
  entry.promise = hardwareProfile.probeStreamInfo(`rtmp://127.0.0.1:1935/${pathName}`).then(info => {
    entry.info = info;
    if (info) console.log(`[dashboard] ${account.twitchLogin} source ${info.width || "?"}x${info.height || "?"} @ ${info.fps || "?"} fps`);
    // Running programs re-frame to the real source size live (no restart).
    for (const e of programCompositors.values()) if (e.accountId === account.twitchUserId) e.compositor.updateHybridPlan?.();
    return info;
  }).catch(() => null);
  sourceInfo.set(account.twitchUserId, entry);
  return entry.promise;
}
function programSettings(account, orientation) {
  const o = orientation === "vertical" ? "vertical" : "landscape";
  const p = (sceneModel.library(account).programs || {})[o];
  if (!p?.auto) return p;
  const auto = hardwareProfile.autoProgram(o, { sourceFps:sourceInfo.get(account.twitchUserId)?.info?.fps || null });
  return { ...p, width:auto.width, height:auto.height, fps:auto.fps, autoTier:auto.tier };
}
function programContext(account) {
  return { enabled:!!account.compositorEnabled, landscape:programSettings(account, "landscape"), vertical:programSettings(account, "vertical") };
}
function programVideo(account, orientation) {
  const p = programSettings(account, orientation);
  return { width:p.width, height:p.height, fps:p.fps, ...(p.bitrateKbps ? { bitrate:`${p.bitrateKbps}k`, maxrate:`${p.bitrateKbps}k`, bufsize:`${p.bitrateKbps * 2}k` } : {}) };
}
// Hybrid program pipeline: FFmpeg decodes the gameplay itself and Chromium
// only renders the transparent overlay layer (see compositor.js). Default on
// for Docker/source installs; the Electron desktop renderer keeps the classic
// path. COMPOSITOR_HYBRID=false restores the classic path everywhere.
function programHybrid() { return hybridEnabled() && !useElectronOffscreen(); }

// Where FFmpeg must place the source video, in output pixels (the page scales
// the scene canvas into the program size with letterboxing).
function hybridPlanFor(accountId, orientation, sceneId, video) {
  const account = getAccount(accountId);
  if (!account) return null;
  const model = resolveProgram(account, orientation, { sceneId, hybrid:true, liveContent:false });
  const pp = model.programPlan;
  if (!pp) return null;
  const W = video.width, H = video.height, cw = model.canvas.width, ch = model.canvas.height;
  const s = Math.min(W / cw, H / ch), ox = (W - cw * s) / 2, oy = (H - ch * s) / 2;
  return { box:{ x:pp.x * s + ox, y:pp.y * s + oy, w:pp.w * s, h:pp.h * s }, program:pp.program };
}

function programPageUrl(account, orientation, sceneId) {
  const params = new URLSearchParams();
  if (sceneId) params.set("scene", sceneId);
  if (programHybrid()) params.set("hybrid", "1");
  const q = params.toString() ? `?${params}` : "";
  return `${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(account.twitchLogin)}/program/${orientation}${q}`;
}
function musicNowFor(accountId) { return profileMusic.getNow(getAccount(accountId), null, { respectScene:true }); }
function musicFileFor(accountId, trackId) {
  const acc = getAccount(accountId);
  const profile = profileMusic.activeProfileFor(acc);
  return profile ? profileMusic.filePathFor(acc, profile.id, trackId) : null;
}

function programEntry(account, orientation, sceneId) {
  const key = programKey(account.twitchUserId, orientation, sceneId);
  let entry = programCompositors.get(key);
  if (entry) return entry;
  const accountId = account.twitchUserId;
  const lib = sceneModel.library(account);
  const pathName = programPathFor(accountId, orientation, sceneId);
  // Read the original ingest, not public/<login>: that copy goes through RTSP
  // in MediaMTX and comes back with audio ~0.1 s off the video.
  const sourceUrl = () => `rtmp://127.0.0.1:1935/${activeFeedPath.get(accountId) || safePathFor(account)}`;
  const compositor = new Compositor({
    accountId:orientation === "landscape" && !sceneId ? accountId : `${accountId}-${orientation}-${safeSeg(sceneId || "live")}`,
    pageUrl:programPageUrl(account, orientation, sceneId),
    audioSourceUrl:sourceUrl,
    outputUrl:`rtmp://127.0.0.1:1935/${pathName}`,
    getMusicNow:() => musicNowFor(accountId),
    musicFilePathFor:trackId => musicFileFor(accountId, trackId),
    video:programVideo(account, orientation),
    browserAudio:sceneModel.libraryNeedsBrowserAudio(account),
    mixer:lib.mixer,
    hybrid:programHybrid() ? { sourceUrl, getSource:() => sourceInfo.get(accountId)?.info || null, getPlan:() => hybridPlanFor(accountId, orientation, sceneId, compositor.video) } : null,
    diagnostics:{ group:"program", label:`${orientation === "vertical" ? "Vertical" : "Horizontal"} program${sceneId ? ` (${sceneModel.findScene(account, sceneId)?.name || sceneId})` : ""}` },
  });
  entry = { key, accountId, orientation, sceneId:sceneId || null, path:pathName, compositor, refs:new Set(), stopTimer:null, signature:JSON.stringify(programVideo(account, orientation)) };
  programCompositors.set(key, entry);
  return entry;
}

function acquireProgram(account, orientation, sceneId, ref) {
  const entry = programEntry(account, orientation, sceneId);
  entry.refs.add(ref);
  if (entry.stopTimer) { clearTimeout(entry.stopTimer); entry.stopTimer = null; }
  if (!["running", "starting", "reconnecting"].includes(entry.compositor.state) && !entry.starting) {
    entry.idleSince = null;
    // Wait for the source probe (fps/size) so an auto program starts at the
    // right frame rate instead of restarting a few seconds later.
    entry.starting = true;
    const pending = sourceInfo.get(account.twitchUserId)?.promise || Promise.resolve(null);
    Promise.race([pending, new Promise(resolve => setTimeout(resolve, 6000))]).finally(() => {
      entry.starting = false;
      if (!programCompositors.has(entry.key) || !entry.refs.size) return;
      const video = programVideo(getAccount(account.twitchUserId) || account, orientation);
      entry.compositor.video = { ...entry.compositor.video, ...video };
      entry.signature = JSON.stringify(video);
      entry.compositor.start();
      const p = programSettings(account, orientation);
      console.log(`[dashboard] ${account.twitchLogin} ${orientation} program started ${video.width}x${video.height}@${video.fps}${p?.autoTier ? ` (auto: ${p.autoTier})` : ""} -> ${entry.path}`);
    });
  }
  return entry;
}

// A program whose consumers are all down (reconnecting / waiting / gave up)
// renders for nobody. Stop it after PROGRAM_NO_CONSUMER_STOP_MS; the next
// destination retry calls acquireProgram(), which starts it again.
const PROGRAM_NO_CONSUMER_STOP_MS = Number(process.env.PROGRAM_NO_CONSUMER_STOP_MS ?? 90000);
function sweepIdlePrograms(now = Date.now()) {
  if (!(PROGRAM_NO_CONSUMER_STOP_MS > 0)) return;
  for (const entry of programCompositors.values()) {
    const live = [...entry.refs].some(ref => ref === "legacy" || activeDestinations.get(ref)?.supervisor?.state === "live");
    if (live || entry.starting) { entry.idleSince = null; continue; }
    entry.idleSince = entry.idleSince || now;
    if (now - entry.idleSince < PROGRAM_NO_CONSUMER_STOP_MS || !["running", "reconnecting", "starting"].includes(entry.compositor.state)) continue;
    console.log(`[dashboard] ${entry.orientation} program ${entry.path} has no live destination for ${Math.round((now - entry.idleSince) / 1000)}s - pausing it to save CPU`);
    entry.compositor.stop().catch(() => {});
  }
}
setInterval(() => sweepIdlePrograms(), 30000).unref?.();

function releaseProgram(key, ref) {
  const entry = programCompositors.get(key);
  if (!entry) return;
  entry.refs.delete(ref);
  if (entry.refs.size || entry.stopTimer) return;
  // Linger briefly so toggling a destination does not thrash Chromium.
  entry.stopTimer = setTimeout(() => {
    entry.stopTimer = null;
    if (entry.refs.size) return;
    programCompositors.delete(entry.key);
    entry.compositor.stop().catch(() => {});
    console.log(`[dashboard] ${entry.orientation} program stopped (no consumers) ${entry.path}`);
  }, PROGRAM_IDLE_STOP_MS);
}

function stopProgramsFor(accountId) {
  for (const entry of [...programCompositors.values()]) {
    if (entry.accountId !== accountId) continue;
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    programCompositors.delete(entry.key);
    entry.compositor.stop().catch(() => {});
  }
}

// Push live scene/mixer/audio changes into running renderers: page content
// updates over SSE (no restart); the mixer applies in the audio relays; only
// a change in whether browser audio is needed (or program size) restarts.
function refreshPrograms(account, { restartOnResize = true } = {}) {
  const lib = sceneModel.library(account);
  const needsAudio = sceneModel.libraryNeedsBrowserAudio(account);
  for (const entry of programCompositors.values()) {
    if (entry.accountId !== account.twitchUserId) continue;
    entry.compositor.setMixer(lib.mixer);
    entry.compositor.setBrowserAudio(needsAudio);
    entry.compositor.updateHybridPlan?.();
    const signature = JSON.stringify(programVideo(account, entry.orientation));
    if (restartOnResize && signature !== entry.signature) {
      entry.signature = signature;
      entry.compositor.video = { ...entry.compositor.video, ...programVideo(account, entry.orientation) };
      if (entry.compositor.state === "running") entry.compositor._scheduleReconnect(250);
    }
  }
  for (const orientation of sceneModel.ORIENTATIONS) events.publish(account.twitchUserId, { type:"program", orientation });
}

// Legacy single-compositor API used elsewhere (and by older tests/tools).
function compositorFor(account) { return programEntry(account, "landscape", null).compositor; }
function startCompositorFor(account) { if (account.compositorEnabled) acquireProgram(account, "landscape", null, "legacy"); }
function stopCompositorFor(accountId) { stopProgramsFor(accountId); }

// ---------------------------------------------------------------------------
// Shared renditions: destinations that must re-encode the same feed to the
// same size/fps/bitrate/encoder share ONE FFmpeg encode and stream-copy it.
function renditionFor(account, plan, sourcePath, ref) {
  const key = renditionKey(plan, sourcePath);
  if (!key) return null;
  let r = renditions.get(key);
  if (!r) {
    const id = crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
    const accountId = account.twitchUserId;
    const outputPath = `rendition/${safeSeg(accountId)}/${id}`;
    r = { key, id, accountId, path:outputPath, refs:new Set(), failed:[], forceCpu:false, encoder:null, plan };
    const pref = plan.output?.videoEncoder || "auto";
    r.supervisor = new SupervisedProcess({
      name:`${account.twitchLogin}/rendition-${id}`,
      shouldRun:() => r.refs.size > 0 && activeFeedPath.has(accountId),
      maxFailures:0,
      build:() => {
        if (sourcePath !== activeFeedPath.get(accountId) && !lastReadyPaths.has(sourcePath)) return { wait:true, reason:`waiting for ${sourcePath}` };
        r.encoder = r.forceCpu ? gpuEncoder.CPU_PROFILE : (r.failed.length ? gpuEncoder.nextWorkingEncoder(pref, r.failed) : gpuEncoder.resolveEncoder(pref));
        r.startedAt = Date.now();
        return { args:renditionArgs(`rtmp://127.0.0.1:1935/${sourcePath}`, r.plan, `rtmp://127.0.0.1:1935/${outputPath}`, { encoder:r.encoder }) };
      },
      onExit:({ code, uptimeMs }) => {
        if (code !== 0 && r.encoder?.hardware && uptimeMs < 8000) {
          r.failed.push(r.encoder.id);
          const next = gpuEncoder.nextWorkingEncoder(pref, r.failed);
          console.warn(`[dashboard] rendition ${id}: ${r.encoder.label} failed quickly - falling back to ${next.label}`);
          if (!next.hardware) r.forceCpu = true;
        }
      },
    });
    r.offDiagnostics = monitor.registerComponent(`destination:${accountId}:rendition-${id}`, { label:`Shared rendition ${plan.width}x${plan.height}@${plan.fps}`, group:"destination", tree:false, pids:() => [r.supervisor.pid()].filter(Boolean), meta:() => ({ encoder:r.encoder?.label || null }) });
    renditions.set(key, r);
  }
  r.refs.add(ref);
  r.supervisor.start();
  return r;
}

function releaseRendition(key, ref) {
  const r = renditions.get(key);
  if (!r) return;
  r.refs.delete(ref);
  if (r.refs.size) return;
  r.supervisor.stop();
  r.offDiagnostics?.();
  renditions.delete(key);
}

const DESTINATION_URL_RE = /^(rtmps?|srt):\/\/.+/i;
const DESTINATION_URL_HINT = "a valid rtmp://, rtmps://, or srt:// url is required";

// Every destination is a supervised FFmpeg worker. Its build() is evaluated
// on each (re)start, so it always reads the current profile, scene routing,
// encoder fallback state and program readiness.
function startDestination(account, dest, _legacyPathName = null, { forceCpu = false } = {}) {
  const accountId = account.twitchUserId;
  const key = `${accountId}:${dest.id}`;
  if (activeDestinations.has(key) || !dest.enabled || !activeFeedPath.has(accountId)) return;
  const worker = { key, destId:dest.id, name:dest.name, forceCpu, failedEncoders:[], encoder:null, plan:null, programKey:null, renditionKey:null, startedAt:null };
  const current = () => findDestination(getAccount(accountId), dest.id) || (dest.id === relayPush.RELAY_DESTINATION_ID ? dest : null);
  worker.supervisor = new SupervisedProcess({
    name:`${account.twitchLogin}/${dest.name}`,
    shouldRun:() => !!current()?.enabled && activeFeedPath.has(accountId),
    // Gave up after repeated failures (bad key, dead ingest): release the
    // program renderer / shared encode it was holding so they can stop too.
    onGiveUp:() => {
      if (worker.programKey) { releaseProgram(worker.programKey, key); worker.programKey = null; }
      if (worker.renditionKey) { releaseRendition(worker.renditionKey, key); worker.renditionKey = null; }
    },
    build:() => {
      const acc = getAccount(accountId);
      const d = current();
      const raw = activeFeedPath.get(accountId);
      if (!acc || !d || !raw) return null;
      const plan = planDestination(d, programContext(acc));
      worker.plan = plan;
      let sourcePath = raw;
      if (plan.feed === "program") {
        const entry = acquireProgram(acc, plan.orientation, plan.sceneId, key);
        if (worker.programKey && worker.programKey !== entry.key) releaseProgram(worker.programKey, key);
        worker.programKey = entry.key;
        sourcePath = entry.path;
      } else if (worker.programKey) { releaseProgram(worker.programKey, key); worker.programKey = null; }
      let effective = plan;
      const shared = !plan.legacy && !plan.copy && String(process.env.DESTINATION_SHARED_RENDITIONS || "true").toLowerCase() !== "false";
      if (shared) {
        const r = renditionFor(acc, plan, sourcePath, key);
        if (worker.renditionKey && worker.renditionKey !== r.key) releaseRendition(worker.renditionKey, key);
        worker.renditionKey = r.key;
        sourcePath = r.path;
        effective = { ...plan, copy:true, feed:"rendition" };
      } else if (worker.renditionKey) { releaseRendition(worker.renditionKey, key); worker.renditionKey = null; }
      if (sourcePath !== raw && !lastReadyPaths.has(sourcePath)) return { wait:true, reason:`waiting for ${sourcePath}` };
      const pref = plan.output?.videoEncoder || "auto";
      worker.encoder = worker.forceCpu ? gpuEncoder.CPU_PROFILE : (worker.failedEncoders.length ? gpuEncoder.nextWorkingEncoder(pref, worker.failedEncoders) : (pref === "auto" ? gpuEncoder.status().selected : gpuEncoder.resolveEncoder(pref)));
      worker.startedAt = Date.now();
      worker.sourcePath = sourcePath;
      const sourceUrl = `rtmp://127.0.0.1:1935/${sourcePath}`;
      const args = plan.legacy ? destinationFfmpegArgs(sourceUrl, d, { forceCpu:worker.forceCpu }) : plannedDestinationArgs(sourceUrl, d, effective, { encoder:worker.encoder, forceCpu:worker.forceCpu });
      return { args };
    },
    onExit:({ code, uptimeMs }) => {
      const plan = worker.plan;
      const transcoding = plan && !(plan.legacy ? plan.copy : true);
      const enc = worker.encoder;
      if (code !== 0 && transcoding && !worker.forceCpu && enc?.hardware && uptimeMs < 8000) {
        worker.failedEncoders.push(enc.id);
        const next = gpuEncoder.nextWorkingEncoder(plan.output?.videoEncoder || "auto", worker.failedEncoders);
        if (!next.hardware) worker.forceCpu = true;
        console.warn(`[dashboard] ${account.twitchLogin}/${dest.name} ${enc.label} failed quickly - falling back to ${next.label}`);
      }
    },
  });
  worker.offDiagnostics = monitor.registerComponent(`destination:${accountId}:${dest.id}`, { label:`Destination · ${dest.name}`, group:"destination", tree:false, pids:() => [worker.supervisor.pid()].filter(Boolean), meta:() => ({ mode:worker.plan?.output?.mode || worker.plan?.layout || null, copy:!!worker.plan?.copy, encoder:worker.plan?.copy ? "copy" : worker.encoder?.label || null }) });
  activeDestinations.set(key, worker);
  worker.supervisor.start();
  const plan = planDestination(dest, programContext(account));
  console.log(`[dashboard] started push -> ${account.twitchLogin}/${dest.name} (${plan.reason})`);
}

function stopDestination(accountId, destId) {
  const key = `${accountId}:${destId}`, worker = activeDestinations.get(key);
  if (!worker) return;
  activeDestinations.delete(key);
  worker.supervisor.stop();
  worker.offDiagnostics?.();
  if (worker.programKey) releaseProgram(worker.programKey, key);
  if (worker.renditionKey) releaseRendition(worker.renditionKey, key);
}
function restartDestination(account, dest) {
  stopDestination(account.twitchUserId, dest.id);
  if (dest.enabled && activeFeedPath.has(account.twitchUserId)) startDestination(account, dest);
}
function stopAllDestinationsFor(accountId) {
  for (const key of [...activeDestinations.keys()]) if (key.startsWith(`${accountId}:`)) stopDestination(accountId, key.slice(String(accountId).length + 1));
}
function destinationHealth(accountId, destId) {
  const worker = activeDestinations.get(`${accountId}:${destId}`);
  if (!worker) return null;
  const s = worker.supervisor.status();
  return { ...s, plan:worker.plan ? { feed:worker.plan.feed, orientation:worker.plan.orientation, copy:!!worker.plan.copy, legacy:!!worker.plan.legacy, reason:worker.plan.reason, shared:!!worker.renditionKey, width:worker.plan.width || null, height:worker.plan.height || null, fps:worker.plan.fps || null } : null, encoder:worker.plan?.copy && !worker.renditionKey ? "stream copy" : (worker.renditionKey ? renditions.get(worker.renditionKey)?.encoder?.label || null : worker.encoder?.label || null), sourcePath:worker.sourcePath || null };
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
async function startRelayPushFor(account, pathName) {
  try {
    const dest = await relayPush.relayDestinationFor(account);
    if (!dest) return;
    if (destinationSourcePathFor(account) !== pathName) return;
    startDestination(account, dest, pathName);
  } catch (error) {
    console.warn(`[dashboard] ${account.twitchLogin} relaystream push registration failed: ${error.message}`);
  }
}
function startOutputsFor(account, pathName) {
  const sourceSession = liveSessions.get(pathName);
  activeFeedPath.set(account.twitchUserId, pathName);
  probeSourceFor(account, pathName);
  startRepublish(account, pathName);
  // Program compositors are started on demand by the destinations that read
  // them (see acquireProgram), so an all-passthrough setup never launches
  // Chromium or re-encodes video at all.
  const source = destinationSourcePathFor(account);
  for (const dest of account.destinations) if (dest.enabled) startDestination(account, dest, source);
  if (account.relayPushEnabled) startRelayPushFor(account, source);
  console.log(`[dashboard] ${account.twitchLogin} routed ${sourceSession?.source || "source"} for profile ${sourceSession?.profileId || "legacy"}`);
}
function clearGrace(accountId) { const grace = graceState.get(accountId); if (!grace) return; clearTimeout(grace.timer); if (grace.idleTimer) clearTimeout(grace.idleTimer); graceState.delete(accountId); }
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
  // Short dropouts keep every output running so Twitch/YouTube do not end the
  // broadcast. After RECONNECT_IDLE_STOP_MS without a source, the renderers
  // and destination pushes are stopped (they would only encode a frozen frame)
  // while the grace window keeps waiting; a reconnect restarts them.
  let idleTimer = null;
  if (RECONNECT_IDLE_STOP_MS > 0 && RECONNECT_IDLE_STOP_MS < RECONNECT_GRACE_MS) {
    idleTimer = setTimeout(() => {
      const grace = graceState.get(account.twitchUserId);
      if (grace?.profileId !== profileId || liveSessions.has(pathName)) return;
      console.log(`[dashboard] ${account.twitchLogin} ${source} still offline after ${Math.round(RECONNECT_IDLE_STOP_MS / 1000)}s - pausing renderers and destinations to save CPU (they restart when the source returns)`);
      stopOutputsFor(account.twitchUserId);
      grace.idleStopped = true;
    }, RECONNECT_IDLE_STOP_MS);
    idleTimer.unref?.();
  }
  graceState.set(account.twitchUserId, { timer, idleTimer, deadline, pathName, source, profileId });
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
  lastReadyPaths = readyPaths;
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
const pollLiveTimer=setInterval(pollLive, POLL_MS);
monitor.registerComponent("dashboard:node",{label:"CastNexus dashboard (Node.js)",group:"dashboard",tree:false,pids:()=>[process.pid]});
monitor.registerComponent("dashboard:republish",{label:"Public republish (stream copy)",group:"dashboard",tree:false,pids:()=>[...activeRepublish.values()].map(child=>child.pid).filter(Boolean)});

const app = express();
app.set("trust proxy", 1);
// Request diagnostics: log API/page requests that are slow or never finish, so
// a "page keeps loading" report shows the stuck request in `docker logs`.
// Long-lived streams (SSE, HLS/WebRTC proxies, media files) are excluded.
const SLOW_REQUEST_MS=Number(process.env.CASTNEXUS_SLOW_REQUEST_MS||3000);
app.use((req,res,next)=>{
  const url=String(req.originalUrl||req.url||"").split("?")[0];
  if(/\/events$|^\/(hls|vrchat-hls|webrtc)\/|\/music\/.*\/file\/|^\/api\/recordings\/play/.test(url))return next();
  const started=Date.now();
  const pending=setTimeout(()=>console.warn(`[http] still pending after 15s: ${req.method} ${url}`),15000);
  pending.unref?.();
  const done=()=>{clearTimeout(pending);const ms=Date.now()-started;if(ms>=SLOW_REQUEST_MS)console.warn(`[http] slow ${req.method} ${url} ${res.statusCode} ${ms}ms`);};
  res.once("finish",done);
  res.once("close",()=>{clearTimeout(pending);if(!res.writableFinished)console.warn(`[http] client gave up: ${req.method} ${url} after ${Date.now()-started}ms`);});
  next();
});
// Browser-side diagnostics (JS errors / page never finished loading). Small,
// rate limited and logged only - never stored or echoed back.
const clientLogBudget=new Map();
app.post("/api/client-log",express.text({type:"*/*",limit:"8kb"}),(req,res)=>{
  const ip=req.ip||"?",now=Date.now(),b=clientLogBudget.get(ip)||{at:now,n:0};
  if(now-b.at>60000){b.at=now;b.n=0;}
  if(++b.n<=20){clientLogBudget.set(ip,b);console.warn(`[client] ${String(req.body||"").replace(/[\r\n]+/g," ").slice(0,1500)}`);}
  res.status(204).end();
});
function fixRedirectPrefix(prefix) { return proxyRes => { const location = proxyRes.headers.location; if (location && location.startsWith("/")) proxyRes.headers.location = prefix + location; }; }

app.use("/setup", require("./setup-routes"));
app.use("/hls", createProxyMiddleware({ target:"http://127.0.0.1:8888", changeOrigin:true, pathRewrite:{ "^/hls":"" }, ws:true, onProxyRes:fixRedirectPrefix("/hls") }));
app.use("/vrchat-hls", createProxyMiddleware({ target:"http://127.0.0.1:8898", changeOrigin:true, pathRewrite:{ "^/vrchat-hls":"" }, ws:true, onProxyRes:fixRedirectPrefix("/vrchat-hls") }));
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
const SESSION_MAX_AGE_MS=Math.max(60*60*1000,Number(process.env.CASTNEXUS_SESSION_MAX_AGE_MS||365*24*60*60*1000));
const sessionStore=new EncryptedFileSessionStore({dir:process.env.CASTNEXUS_SESSION_DIR||path.join(path.dirname(STATE_FILE),"sessions"),secret:state.sessionSecret});
app.use(session({name:"castnexus.sid",store:sessionStore,secret:state.sessionSecret,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax",secure:"auto",maxAge:SESSION_MAX_AGE_MS}}));
function sessionAccount(req){const account=getAccount(req.session.accountId);if(accountSessionIsValid(account))return account;if(req.session.accountId)req.session.destroy(()=>{});return null;}
function requireAuth(req,res,next){const account=sessionAccount(req);if(!account)return res.status(401).json({error:"not authenticated or OAuth authorization expired"});req.account=account;next();}
const STUDIO_HTML = path.join(__dirname,"public","index.html");
function siteHeaders(res){res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");}
function sendPublicPage(res,html){siteHeaders(res);res.setHeader("Cache-Control","public, max-age=300");res.type("html").send(html);}
app.get("/",(_req,res)=>sendPublicPage(res,homePage()));
app.get("/privacy",(_req,res)=>sendPublicPage(res,privacyPage()));
app.get("/terms",(_req,res)=>sendPublicPage(res,termsPage()));
app.get("/login",(req,res)=>{if(sessionAccount(req))return res.redirect("/dashboard");sendPublicPage(res,loginPage());});
app.get("/dashboard",(req,res)=>{if(!sessionAccount(req))return res.redirect("/login");siteHeaders(res);res.setHeader("Cache-Control","no-store");res.sendFile(STUDIO_HTML);});
const SOURCE_MODES=["console","pc","both"];
function needsStreamKeyFor(account){return (account.sourceMode==="console"||account.sourceMode==="both")&&!account.streamKey;}
function requireOnboarded(req,res,next){if(!req.account.sourceMode)return res.status(403).json({error:"pick a source mode first"});if(needsStreamKeyFor(req.account))return res.status(403).json({error:"must set stream key"});next();}

function loginTwitchUser(req, twitchUser) {
  let account=state.accounts[twitchUser.id];const isNewAccount=!account;
  const decision=registration.loginDecision({accountExists:!isNewAccount,login:twitchUser.login});
  if(!decision.allowed){console.warn(`[dashboard] sign-in refused (${decision.reason}): ${twitchUser.login}`);const refused=new Error(registration.refusalMessage(decision.reason));refused.refusalReason=decision.reason;refused.status=403;throw refused;}
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

app.get("/auth/twitch",(req,res)=>beginHostedOauth(req,res,"twitch"));
app.get("/auth/youtube",requireAuth,(req,res)=>beginHostedOauth(req,res,"youtube"));

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
const SCENE_KINDS=["none","builtin","custom"],BUILTIN_SCENE_NAMES=["startingSoon","brb","ending","offline"];
app.get("/api/scenes/current",requireAuth,(req,res)=>res.json({currentScene:req.account.currentScene}));
app.post("/api/scenes/current",requireAuth,(req,res)=>{const{kind,name,overlayId}=req.body||{};if(!SCENE_KINDS.includes(kind))return res.status(400).json({error:`kind must be one of ${SCENE_KINDS.join(", ")}`});let scene=null;if(kind==="builtin"){if(!BUILTIN_SCENE_NAMES.includes(name))return res.status(400).json({error:`name must be one of ${BUILTIN_SCENE_NAMES.join(", ")}`});scene={kind,name,since:new Date().toISOString()};if(name==="startingSoon"){const minutes=Number(req.account.overlayConfig?.startingSoon?.countdownMinutes||0);if(Number.isFinite(minutes)&&minutes>0)scene.countdownAt=new Date(Date.now()+minutes*60000).toISOString();}}else if(kind==="custom"){const overlay=req.account.overlays.find(o=>o.id===overlayId&&(o.type==="text"||o.type==="html"||o.type==="music"));if(!overlay)return res.status(404).json({error:"unknown overlay"});scene={kind,overlayId};}req.account.currentScene=scene;saveState(state);const html=withWidgets(resolveSceneFragment(scene,req.account),req.account.overlayConfig,req.account.twitchLogin);events.publish(req.account.twitchUserId,{type:"scene",html});for(const orientation of sceneModel.ORIENTATIONS)events.publish(req.account.twitchUserId,{type:"program",orientation});for(const entry of programCompositors.values())if(entry.accountId===req.account.twitchUserId)entry.compositor.updateHybridPlan?.();res.json({ok:true,currentScene:scene});});
app.get("/api/compositor",requireAuth,(req,res)=>res.json({enabled:!!req.account.compositorEnabled}));
app.get("/api/public-base-url",requireAuth,(req,res)=>{res.json({value:state.publicBaseUrl||"",effective:publicPlaybackBase(req),lockedByEnv:!!PUBLIC_BASE_URL_ENV});});
app.post("/api/public-base-url",requireAuth,(req,res)=>{
  if(PUBLIC_BASE_URL_ENV)return res.status(409).json({error:"PUBLIC_BASE_URL is set in the environment and takes precedence"});
  const raw=String(req.body?.value??"").trim();
  if(!raw){delete state.publicBaseUrl;saveState(state);return res.json({ok:true,value:"",effective:publicPlaybackBase(req)});}
  const normalised=normalisePublicBase(raw);
  if(!normalised)return res.status(400).json({error:"enter a host or full url, for example https://castnexus.example.com"});
  state.publicBaseUrl=normalised;
  saveState(state);
  res.json({ok:true,value:normalised,effective:publicPlaybackBase(req)});
});
app.post("/api/compositor",requireAuth,(req,res)=>{req.account.compositorEnabled=Boolean(req.body?.enabled);saveState(state);const activePath=activeFeedPath.get(req.account.twitchUserId);if(activePath){stopOutputsFor(req.account.twitchUserId);startOutputsFor(req.account,activePath);}res.json({ok:true,enabled:req.account.compositorEnabled});});

function configuredPublicBaseUrl(){return PUBLIC_BASE_URL_ENV||normalisePublicBase(state.publicBaseUrl)||"";}
function publicPlaybackBase(req){return publicBaseUrl(req,{explicitBase:configuredPublicBaseUrl()});}
function playbackUrlsFor(req,account){if(!activeSourceFor(account.twitchUserId))return null;return playbackTargets({base:publicPlaybackBase(req),safePath:safePathFor(account),mediaHost:PUBLIC_MEDIA_HOST});}
function sourcesStatusFor(account){const selected=activeProfile(account);const sources={console:{enabled:selected?.mode==="console",live:false},pc:{enabled:selected?.mode==="pc",live:false},music:{enabled:selected?.mode==="music",live:false},rerun:{enabled:selected?.mode!=="console",live:false}};const connectedProfiles=[];for(const[pathName,live]of liveSessions.entries()){if(live.accountId!==account.twitchUserId)continue;connectedProfiles.push({profileId:live.profileId,source:live.source,path:pathName,active:activeFeedPath.get(account.twitchUserId)===pathName});if(live.profileId===selected?.id&&sources[live.source])sources[live.source].live=true;}return{sources,activeSource:activeSourceFor(account.twitchUserId),connectedProfiles};}
app.get("/api/status",requireAuth,(req,res)=>{const account=req.account;ensureAccountProfileKeys(account);const selected=activeProfile(account),rtmp=profileRtmp.profileRtmpInfo(account,MEDIA_HOST,selected?.id);const{sources,activeSource,connectedProfiles}=sourcesStatusFor(account);res.json({twitchLogin:account.twitchLogin,displayName:account.displayName,profileImageUrl:account.profileImageUrl,needsSourceMode:!account.sourceMode,needsStreamKey:needsStreamKeyFor(account),streamKeyMasked:account.streamKey?maskSecret(account.streamKey):null,sourceMode:account.sourceMode||null,activeProfileId:selected?.id||null,profileRtmp:rtmp,live:!!activeSource,sources,activeSource,connectedProfiles,rerun:profileVod.publicStatus(account.twitchUserId),recordingEnabled:!!account.recordingEnabled,encoder:gpuEncoder.status(),graceUntil:graceState.get(account.twitchUserId)?.deadline??null,pcServer:rtmp?.server||`rtmp://${MEDIA_HOST}:1935/${PC_APP}`,pcKey:rtmp?.key||account.pcKey,mediaHost:MEDIA_HOST,publicBaseUrl:{value:state.publicBaseUrl||"",effective:publicPlaybackBase(req),lockedByEnv:!!PUBLIC_BASE_URL_ENV},playback:playbackUrlsFor(req,account),destinations:account.destinations.map(d=>({id:d.id,name:d.name,platform:normaliseDestinationPlatform(d.platform),urlMasked:maskUrl(d.url),layout:normaliseLayout(d.layout),output:effectiveOutput(d),outputConfigured:!!d.output,route:planDestination(d,programContext(account)).reason,enabled:d.enabled,active:activeDestinations.has(`${account.twitchUserId}:${d.id}`),health:destinationHealth(account.twitchUserId,d.id)})),programs:programStatusFor(account),music24:music24Status(account),relayPush:{available:!!relayPush.relaystreamBaseUrl(),enabled:!!account.relayPushEnabled,mode:account.relayPushMode,nodeId:account.relayNodeId,active:activeDestinations.has(`${account.twitchUserId}:${relayPush.RELAY_DESTINATION_ID}`),watchUrl:relayPush.cachedRelayDestination(account)?.watchUrl||null}});});
app.post("/api/relay-push",requireAuth,requireOnboarded,(req,res)=>{const{enabled,mode}=req.body||{};if(enabled&&!relayPush.relaystreamBaseUrl())return res.status(503).json({error:"RELAYSTREAM_URL is not configured on this install"});if(mode!==undefined){if(!["rtmp","whip"].includes(mode))return res.status(400).json({error:"mode must be rtmp or whip"});req.account.relayPushMode=mode;}const wasEnabled=req.account.relayPushEnabled;if(enabled!==undefined)req.account.relayPushEnabled=Boolean(enabled);saveState(state);const source=destinationSourcePathFor(req.account);if(req.account.relayPushEnabled){if(source){if(wasEnabled)stopDestination(req.account.twitchUserId,relayPush.RELAY_DESTINATION_ID);startRelayPushFor(req.account,source);}}else{stopDestination(req.account.twitchUserId,relayPush.RELAY_DESTINATION_ID);}res.json({ok:true,enabled:req.account.relayPushEnabled,mode:req.account.relayPushMode});});
// `output` is the per-destination layout (mode/scene/size/fps/encoder/bitrate/
// audio/captions). `layout` is still accepted for older clients and scripts;
// a destination that never received `output` keeps its historic behaviour.
function layoutForOutput(output){return output.mode==="source"?"source":output.mode==="vertical"||(output.mode==="custom"&&output.height>output.width)?"vertical":"landscape";}
function validateOutput(raw){if(raw===undefined||raw===null)return{output:undefined};if(typeof raw!=="object")return{error:"output must be an object"};if(raw.mode!==undefined&&!OUTPUT_MODES.includes(raw.mode))return{error:`output.mode must be one of ${OUTPUT_MODES.join(", ")}`};return{output:sanitiseOutput(raw)};}
app.post("/api/destinations",requireAuth,requireOnboarded,(req,res)=>{const{name,url,layout,platform}=req.body||{};if(!name||!String(name).trim())return res.status(400).json({error:"name is required"});if(!url||!DESTINATION_URL_RE.test(url))return res.status(400).json({error:DESTINATION_URL_HINT});if(layout!==undefined&&!OUTPUT_LAYOUTS.includes(layout))return res.status(400).json({error:`layout must be one of ${OUTPUT_LAYOUTS.join(", ")}`});const checked=validateOutput(req.body?.output);if(checked.error)return res.status(400).json({error:checked.error});if(checked.output?.sceneId&&!sceneModel.findScene(req.account,checked.output.sceneId))return res.status(404).json({error:"unknown scene for destination"});const dest={id:crypto.randomUUID(),name:String(name).trim(),platform:normaliseDestinationPlatform(platform),url:String(url).trim(),layout:checked.output?layoutForOutput(checked.output):normaliseLayout(layout),enabled:false,...(checked.output?{output:checked.output}:{})};req.account.destinations.push(dest);saveState(state);res.json({ok:true,id:dest.id});});
app.put("/api/destinations/:id",requireAuth,requireOnboarded,(req,res)=>{const dest=findDestination(req.account,req.params.id);if(!dest)return res.status(404).json({error:"unknown destination"});const{name,url,layout}=req.body||{};let restart=false;if(name!==undefined){if(!String(name).trim())return res.status(400).json({error:"name cannot be empty"});dest.name=String(name).trim();}if(url!==undefined){if(!DESTINATION_URL_RE.test(url))return res.status(400).json({error:DESTINATION_URL_HINT});dest.url=String(url).trim();restart=true;}const checked=validateOutput(req.body?.output);if(checked.error)return res.status(400).json({error:checked.error});if(checked.output){if(checked.output.sceneId&&!sceneModel.findScene(req.account,checked.output.sceneId))return res.status(404).json({error:"unknown scene for destination"});if(JSON.stringify(dest.output||null)!==JSON.stringify(checked.output)){dest.output=checked.output;dest.layout=layoutForOutput(checked.output);restart=true;}}else if(layout!==undefined){if(!OUTPUT_LAYOUTS.includes(layout))return res.status(400).json({error:`layout must be one of ${OUTPUT_LAYOUTS.join(", ")}`});if(dest.layout!==layout){dest.layout=layout;delete dest.output;restart=true;}}saveState(state);if(restart&&dest.enabled&&activeFeedPath.has(req.account.twitchUserId))restartDestination(req.account,dest);res.json({ok:true,output:effectiveOutput(dest),route:planDestination(dest,programContext(req.account)).reason});});
app.delete("/api/destinations/:id",requireAuth,requireOnboarded,(req,res)=>{const dest=findDestination(req.account,req.params.id);if(!dest)return res.status(404).json({error:"unknown destination"});stopDestination(req.account.twitchUserId,dest.id);req.account.destinations=req.account.destinations.filter(d=>d.id!==dest.id);saveState(state);res.json({ok:true});});
app.post("/api/destinations/:id/toggle",requireAuth,requireOnboarded,(req,res)=>{const dest=findDestination(req.account,req.params.id);if(!dest)return res.status(404).json({error:"unknown destination"});dest.enabled=Boolean(req.body?.enabled);saveState(state);const source=destinationSourcePathFor(req.account);if(source){if(dest.enabled)startDestination(req.account,dest,source);else stopDestination(req.account.twitchUserId,dest.id);}res.json({ok:true});});

// ---------------------------------------------------------------------------
// Overlay Studio scene library API. Every write publishes a "program" SSE
// event; open program pages (the compositors and dashboard previews) diff
// their layers in place, so edits and scene switches never restart a stream.
const music24Runtime = require("./music24");

function programStatusFor(account) {
  const out = [];
  for (const entry of programCompositors.values()) {
    if (entry.accountId !== account.twitchUserId) continue;
    const s = entry.compositor.status();
    out.push({ orientation:entry.orientation, sceneId:entry.sceneId, path:entry.path, consumers:entry.refs.size, state:s.state, error:s.error, encoder:s.encoder, hardwareEncoder:s.hardwareEncoder, encoderFallbackReason:s.encoderFallbackReason, width:s.width, height:s.height, fps:s.outputFps, renderFps:s.renderFps, measuredRenderFps:s.measuredRenderFps, measuredEncodeFps:s.measuredEncodeFps, hybrid:!!s.hybrid, browserAudio:s.browserAudio, mixer:s.mixer });
  }
  return out;
}

function music24Status(account) {
  try { return music24Runtime.statusFor(account.twitchUserId); } catch { return null; }
}

function libraryResponse(account) {
  const lib = sceneModel.library(account);
  return {
    library:lib,
    layerTypes:sceneModel.LAYER_TYPES,
    browserTypes:sceneModel.BROWSER_TYPES,
    audioTypes:sceneModel.AUDIO_TYPES,
    slotNames:sceneModel.SLOT_NAMES,
    slotModes:sceneModel.SLOT_MODES,
    canvasPresets:sceneModel.CANVAS_PRESETS,
    currentScene:account.currentScene || null,
    onAir:Object.fromEntries(sceneModel.ORIENTATIONS.map(o => {
      const model = resolveProgram(account, o, { liveContent:false });
      return [o, { source:model.source, sceneId:model.sceneId, sceneName:model.sceneName, canvas:model.canvas, browserAudio:model.browserAudio }];
    })),
    browserAudioNeeded:sceneModel.libraryNeedsBrowserAudio(account),
    programs:programStatusFor(account),
  };
}

function sceneWrite(res, account, fn) {
  try {
    const result = fn();
    saveState(state);
    refreshPrograms(account);
    res.json({ ok:true, ...result, ...libraryResponse(account) });
  } catch (error) {
    res.status(error.status || 400).json({ error:error.message });
  }
}

app.get("/api/scenes/library", requireAuth, (req, res) => res.json(libraryResponse(req.account)));
app.post("/api/scenes/library/scenes", requireAuth, (req, res) => sceneWrite(res, req.account, () => ({ scene:sceneModel.createScene(req.account, req.body || {}) })));
app.put("/api/scenes/library/scenes/:id", requireAuth, (req, res) => sceneWrite(res, req.account, () => {
  const scene = sceneModel.updateScene(req.account, req.params.id, req.body || {});
  if (!scene) throw Object.assign(new Error("unknown scene"), { status:404 });
  return { scene };
}));
app.delete("/api/scenes/library/scenes/:id", requireAuth, (req, res) => sceneWrite(res, req.account, () => {
  if (!sceneModel.deleteScene(req.account, req.params.id)) throw Object.assign(new Error("unknown scene"), { status:404 });
  // Destinations pinned to a deleted scene fall back to following the live scene.
  for (const dest of req.account.destinations) if (dest.output?.sceneId === req.params.id) { dest.output = { ...dest.output, sceneId:null }; if (dest.enabled) restartDestination(req.account, dest); }
  return {};
}));
// Switch what LIVE / GAMEPLAY shows for one orientation. SSE only.
app.post("/api/scenes/library/live", requireAuth, (req, res) => sceneWrite(res, req.account, () => ({ live:sceneModel.setLive(req.account, req.body?.orientation, req.body?.sceneId) })));
// Turn Starting Soon / BRB / Ending / Offline into their own editable layered
// scenes (16:9 + 9:16), pre-filled from the built-in text. Idempotent.
app.post("/api/scenes/library/slots/:name/customise", requireAuth, (req, res) => sceneWrite(res, req.account, () => sceneModel.customiseSlot(req.account, req.params.name, req.account.overlayConfig)));
app.put("/api/scenes/library/slots/:name", requireAuth, (req, res) => sceneWrite(res, req.account, () => ({ slot:sceneModel.setSlot(req.account, req.params.name, req.body || {}) })));
app.put("/api/scenes/library/mixer", requireAuth, (req, res) => sceneWrite(res, req.account, () => ({ mixer:sceneModel.setMixer(req.account, req.body || {}) })));
app.put("/api/scenes/library/programs", requireAuth, (req, res) => sceneWrite(res, req.account, () => {
  const programs = sceneModel.setPrograms(req.account, req.body || {});
  const effects = String(req.body?.effects || "");
  if (["auto", "full", "reduced", "minimal"].includes(effects)) programs.effects = effects;
  // Copy destinations must re-evaluate copy vs transcode against the new size.
  for (const dest of req.account.destinations) if (dest.enabled && dest.output) restartDestination(req.account, dest);
  return { programs };
}));

// System / performance diagnostics. Sampling is cached inside the monitor
// (2 s on Linux, 15 s on Windows), so polling this is cheap.
// Hardware test: host type, working encoder, real Chromium GPU, measured CPU
// speed and the Auto quality it leads to. POST re-runs it (a few seconds).
function hardwareSummary(account) {
  const h = hardwareProfile.getHostProfile();
  const program = o => { const p = programSettings(account, o); return p ? { width:p.width, height:p.height, fps:p.fps, auto:!!p.auto, tier:p.autoTier || null } : null; };
  return {
    probed:!!h.probed, probedAt:h.probedAt || null, probeMs:h.probeMs || null,
    hostType:h.hostType, cores:h.cores, cpuModel:h.cpuModel, ramBytes:h.ramBytes || null,
    encoder:h.encoder, hardwareEncoder:h.hardwareEncoder,
    chromiumGpu:h.chromiumGpu, chromiumRenderer:h.chromium?.renderer || null, chromiumReason:h.chromium?.reason || null,
    x264MsPerFrame1080p:Math.round(h.cpu.coreSecondsPerFrame * 10000) / 10,
    cpuSpeedVsReference:h.cpuSpeedVsReference,
    budget:hardwareProfile.budgetFor(h),
    music:h.recommendations.music,
    program:h.recommendations.program,
    programs:{ landscape:program("landscape"), vertical:program("vertical") },
    sourceStream:sourceInfo.get(account.twitchUserId)?.info || null,
    ffmpeg:require("./ffmpeg-select").status(),
    tooHeavy:h.tooHeavy || {},
  };
}
app.get("/api/system/hardware", requireAuth, (req, res) => res.json(hardwareSummary(req.account)));
app.post("/api/system/hardware/probe", requireAuth, async (req, res) => {
  try {
    await hardwareProfile.ensureHostProfile({ force:true });
    // The FFmpeg build is chosen at startup; re-benchmark on the next restart.
    require("./ffmpeg-select").clearCache();
    // Running auto workers/programs pick the new recommendation up: Music via
    // its signature on the next reconcile, programs via a renderer restart.
    refreshPrograms(req.account);
    res.json({ ok:true, ...hardwareSummary(req.account) });
  } catch (error) {
    res.status(500).json({ error:error.message });
  }
});

app.post("/api/music24/streaming", requireAuth, (req, res) => {
  const enabled = music24Runtime.setStreaming(req.account.twitchUserId, req.body?.enabled === true);
  console.log(`[music24] ${req.account.twitchLogin} turned Music 24/7 streaming ${enabled ? "on" : "off"}`);
  res.json({ ok:true, enabled, music24:music24Status(req.account) });
});

app.get("/api/system/performance", requireAuth, (req, res) => {
  const snapshot = monitor.sample();
  const mine = snapshot.components.filter(row => row.name.includes(String(req.account.twitchUserId)) || row.group === "dashboard");
  const destinations = req.account.destinations.map(d => ({ id:d.id, name:d.name, enabled:d.enabled, active:activeDestinations.has(`${req.account.twitchUserId}:${d.id}`), route:planDestination(d, programContext(req.account)).reason, health:destinationHealth(req.account.twitchUserId, d.id) }));
  res.json({
    at:snapshot.at,
    intervalMs:snapshot.intervalMs,
    supported:snapshot.supported,
    system:snapshot.system,
    components:mine,
    groups:monitor.groupTotals({ components:mine }),
    encoder:gpuEncoder.status(),
    hardware:hardwareSummary(req.account),
    music24:music24Status(req.account),
    programs:programStatusFor(req.account),
    destinations,
  });
});

app.get("/api/destinations/capabilities", requireAuth, (req, res) => {
  const order = gpuEncoder.fallbackOrder("auto");
  res.json({
    outputModes:OUTPUT_MODES,
    encoders:gpuEncoder.PREFERENCES.map(id => ({ id, label:gpuEncoder.PREFERENCE_LABELS[id], available:id === "auto" || id === "cpu" || order.some(p => p.id === id) })),
    captions:captions.captionCapabilities(),
    programs:sceneModel.library(req.account).programs,
    scenes:sceneModel.library(req.account).scenes.map(s => ({ id:s.id, name:s.name, orientation:s.orientation })),
    musicPerformanceModes:performanceModes.MODES.map(id => ({ id, label:performanceModes.MODE_LABELS[id] })),
    musicRenderFps:performanceModes.RENDER_FPS_CHOICES,
  });
});

app.get("/build-info.js",(_req,res)=>{
  const info={
    name:"CastNexus",
    version:process.env.CASTNEXUS_VERSION||"0.0.0-dev",
    channel:process.env.CASTNEXUS_CHANNEL||"dev",
    installType:process.env.CASTNEXUS_INSTALL_TYPE||"source",
    repository:"NekoSuneProjects/CastNexus",
  };
  res.type("application/javascript").send(`window.CASTNEXUS_BUILD = Object.freeze(${JSON.stringify(info)});\n`);
});
app.use(express.static(path.join(__dirname,"public"),{index:false}));
const httpServer=app.listen(PORT,()=>{const encoder=gpuEncoder.status().selected;console.log(`[dashboard] listening on :${PORT}`);hardwareProfile.ensureHostProfile().catch(()=>{});console.log(`[dashboard] video encoder: ${encoder.label}${encoder.hardware?" (hardware)":" (software fallback)"}`);console.log(`[dashboard] oauth-broker: ${hostedOauth.baseUrl}`);const allowList=registration.allowedLogins();if(allowList.length)console.log(`[dashboard] sign-in restricted to: ${allowList.join(", ")}`);else if(registration.registrationDisabled())console.log(`[dashboard] registration disabled - only the ${Object.keys(state.accounts).length} existing account(s) can sign in`);if(registration.locksOutEveryone({accountCount:Object.keys(state.accounts).length}))console.warn("[dashboard] DISABLE_REGISTRATION is set but no account exists yet - nobody can sign in. Set ALLOWED_TWITCH_LOGINS to your Twitch login, or unset DISABLE_REGISTRATION for one sign-in.");});

let dashboardShuttingDown=false;
async function shutdown(){
  if(dashboardShuttingDown)return;
  dashboardShuttingDown=true;
  clearInterval(pollLiveTimer);
  for(const grace of graceState.values())clearTimeout(grace.timer);
  graceState.clear();activeFeedPath.clear();
  for(const worker of activeDestinations.values()){try{worker.supervisor.stop();}catch{}}
  for(const r of renditions.values()){try{r.supervisor.stop();}catch{}}
  for(const child of activeRepublish.values()){child.removeAllListeners("exit");killHard(child);}
  activeDestinations.clear();activeRepublish.clear();renditions.clear();
  const programs=[...programCompositors.values()];
  for(const entry of programs)if(entry.stopTimer)clearTimeout(entry.stopTimer);
  programCompositors.clear();
  await Promise.allSettled([...programs.map(entry=>entry.compositor.stop()),...[...compositors.values()].map(compositor=>compositor.stop())]);
  compositors.clear();
  await new Promise(resolve=>{try{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();};const timer=setTimeout(finish,2000);httpServer.close(finish);httpServer.closeAllConnections?.();}catch{resolve();}});
}
module.exports={shutdown};
