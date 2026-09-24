"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Compositor } = require("./compositor");
const { resolveEncoder, normalisePreference } = require("./gpu-encoder");
const { safeCanvas } = require("./rtmp-pipeline");
const { activeProfileFor, profilePublishPath, validRtmpKey } = require("./profile-rtmp");
const { resolveMusicPerformance, sceneQueryFor, normaliseMode, everyNthFrameFor } = require("./performance-modes");
const events = require("./events");
const monitor = require("./resource-monitor");
const hardwareProfile = require("./hardware-profile");
const { bucketKey } = require("./profile-destinations");

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "data", "state.json");
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(path.dirname(STATE_FILE), "music");
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8090);
const DASHBOARD_ORIGIN = process.env.DASHBOARD_INTERNAL_ORIGIN || `http://127.0.0.1:${DASHBOARD_PORT}`;
const RTMP_ORIGIN = process.env.MEDIA_RTMP_ORIGIN || "rtmp://127.0.0.1:1935";
const MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
const FFPROBE_BIN = process.env.FFPROBE_BIN || "ffprobe";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const POLL_MS = Number(process.env.MUSIC24_POLL_MS || 2000);
// Now-playing is event driven (music engine "music" events + a timer at the
// end of each track). This interval is only the safety resync. It used to be
// 750 ms of loopback HTTP requests forever.
const NOW_POLL_MS = Math.max(1000, Number(process.env.MUSIC24_NOW_POLL_MS || 5000));
const START_TIMEOUT_MS = Number(process.env.MUSIC24_START_TIMEOUT_MS || 15000);
const API_PROBE_TIMEOUT_MS = Number(process.env.MUSIC24_API_PROBE_TIMEOUT_MS || 700);
const RTMP_PROBE_TIMEOUT_MS = Number(process.env.MUSIC24_RTMP_PROBE_TIMEOUT_MS || 2500);

const workers = new Map();
const lastStatus = new Map();
let shuttingDown = false;
let serviceStarted = false;
let reconcileTimer = null;
let apiFallbackLogged = false;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function sanitizeSegment(value) { return String(value || "unknown").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120); }
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; } }

function profileMusicState(account, profile) {
  if (!account || !profile?.id) return null;
  const key = sanitizeSegment(profile.id);
  const bucket = account.musicProfiles?.[key];
  return {
    profileId:key,
    tracks:Array.isArray(bucket?.tracks) ? bucket.tracks : [],
    settings:bucket?.settings || {},
  };
}

// Dashboard-controlled Music 24/7 settings (profile.musicPerformance), with
// the old MUSIC24_* environment variables as defaults. `explicit` records
// what the user actually chose, so Auto only fills in the rest.
function musicPerformanceSettings(profile) {
  const raw = profile?.musicPerformance && typeof profile.musicPerformance === "object" ? profile.musicPerformance : {};
  const vertical = profile?.canvasMode === "vertical";
  const positive = value => (Number(value) > 0 ? Math.round(Number(value)) : null);
  const explicitSize = !!(positive(raw.width) && positive(raw.height)) || !!(process.env.MUSIC24_WIDTH && process.env.MUSIC24_HEIGHT && String(process.env.MUSIC24_AUTO_SIZE || "").toLowerCase() === "false");
  let width = positive(raw.width) || Number(process.env.MUSIC24_WIDTH || (vertical ? 1080 : 1920));
  let height = positive(raw.height) || Number(process.env.MUSIC24_HEIGHT || (vertical ? 1920 : 1080));
  // A landscape size on a vertical profile (or vice versa) is rotated rather
  // than stretched.
  if (vertical !== (height > width)) [width, height] = [height, width];
  return {
    mode:normaliseMode(raw.mode || process.env.MUSIC24_PERFORMANCE_MODE),
    encoder:normalisePreference(raw.encoder || process.env.MUSIC24_ENCODER || "auto"),
    width,
    height,
    fps:Math.max(1, Math.min(60, positive(raw.fps) || Number(process.env.MUSIC24_FPS || 30))),
    renderFps:positive(raw.renderFps),
    bitrateKbps:positive(raw.bitrateKbps),
    explicit:{ size:explicitSize, fps:!!positive(raw.fps) },
  };
}

// COMPOSITOR_GPU=auto now trusts the hardware test: headless Chromium only
// gets GPU flags when the probe saw a real GPU renderer (not SwiftShader).
// Before the first probe the old rule (hardware encoder => GPU) applies.
function chromiumGpuFor(hardwareEncoder, host = hardwareProfile.getHostProfile()) {
  const mode = String(process.env.COMPOSITOR_GPU || "auto").toLowerCase();
  if (mode === "true") return true;
  if (mode !== "auto") return false;
  return host?.probed ? !!host.chromiumGpu : !!hardwareEncoder;
}

// The quality tier Auto uses for this profile on this host, or null when the
// user pinned a mode / size or forced CASTNEXUS_CPU_SAFE_MODE.
function autoTierFor(settings, encoder, host) {
  const safe = String(process.env.CASTNEXUS_CPU_SAFE_MODE ?? "").toLowerCase();
  if (settings.mode !== "auto" || settings.explicit.size || ["true", "1", "yes", "on"].includes(safe)) return null;
  // Recommendation for the encoder this profile will really use.
  const view = encoder.hardware === host.hardwareEncoder ? host : hardwareProfile.finalise({ ...host, hardwareEncoder:encoder.hardware });
  return view.recommendations?.music || null;
}

function profileVideo(profile) {
  const vertical = profile?.canvasMode === "vertical";
  const settings = musicPerformanceSettings(profile);
  const encoder = resolveEncoder(settings.encoder);
  const host = hardwareProfile.getHostProfile();
  const chromiumGpu = chromiumGpuFor(encoder.hardware, host);
  const tier = autoTierFor(settings, encoder, host);
  let canvas;
  let perfSettings = settings;
  if (tier) {
    // Auto: the best tier this host's measured CPU/GPU can hold in realtime.
    canvas = vertical ? { width:tier.height, height:tier.width, fps:settings.explicit.fps ? settings.fps : tier.fps } : { width:tier.width, height:tier.height, fps:settings.explicit.fps ? settings.fps : tier.fps };
    perfSettings = { ...settings, mode:tier.mode };
  } else if (settings.mode === "auto") {
    // Auto with a pinned size, or CPU-safe mode forced on: previous behaviour.
    canvas = safeCanvas(vertical ? "vertical" : "landscape", { hardwareEncoder:encoder.hardware, width:settings.width, height:settings.height, fps:settings.fps });
  } else {
    canvas = { width:settings.width, height:settings.height, fps:settings.fps };
  }
  const perf = resolveMusicPerformance(perfSettings, { hardwareEncoder:encoder.hardware, chromiumGpu, outputFps:canvas.fps });
  if (tier) perf.requested = "auto";
  const bitrate = settings.bitrateKbps ? `${settings.bitrateKbps}k` : (process.env.MUSIC24_VIDEO_BITRATE || "3500k");
  return {
    ...canvas,
    renderFps:perf.renderFps,
    screencastQuality:perf.jpegQuality,
    // Full effects animate at Chromium's 60 Hz; skip frames above the capture
    // rate. Reduced/minimal pages only change at spectrumHz already.
    screencastEveryNth:perf.effects === "full" ? everyNthFrameFor(perf.renderFps) : 1,
    gpuEnabled:chromiumGpu,
    performance:perf,
    autoTier:tier ? tier.id : null,
    autoReason:tier ? `${host.hostType?.label || "host"}: ~${tier.cores} of ${tier.budgetCores} budget cores${host.probed ? "" : " (estimate - hardware test pending)"}` : null,
    encoderPreference:settings.encoder,
    encoderLabel:encoder.label,
    // Music visualisers contain far less motion/detail than gameplay. This
    // keeps Twitch quality clean while reducing viewer decode/network load.
    bitrate,
    maxrate:process.env.MUSIC24_VIDEO_MAXRATE||bitrate,
    bufsize:process.env.MUSIC24_VIDEO_BUFSIZE||`${Math.max(1000, (parseInt(bitrate, 10) || 3500) * 2)}k`,
    // Two-second GOP: music frames barely change, and a longer GOP makes the
    // repeated (skipped) frames between keyframes almost free.
    gopSeconds:2,
  };
}

// Extra Compositor options derived from the profile. Exported so the
// benchmark tool drives the exact same configuration as production.
function compositorExtras(profile, video = profileVideo(profile)) {
  return {
    encoderPreference:video.encoderPreference || "auto",
    diagnostics:{ group:"music24", label:`Music 24/7 (${profile?.name || profile?.id || "profile"})` },
  };
}

function musicSceneUrl(account, profile) {
  const params = new URLSearchParams();
  const visual = profile?.musicVisual || {};
  for (const key of ["accent", "background", "station", "title", "cover"]) {
    if (visual[key]) params.set(key, String(visual[key]));
  }
  params.set("layout", profile?.canvasMode === "vertical" ? "vertical" : "landscape");
  const perf = profileVideo(profile).performance;
  for (const [key, value] of Object.entries(sceneQueryFor(perf))) params.set(key, value);
  const query = params.toString();
  return `${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(account.twitchLogin)}/music/${encodeURIComponent(profile.id)}${query ? `?${query}` : ""}`;
}

function activeProgramScene(account) {
  const scene = account?.currentScene;
  return scene && scene.kind && scene.kind !== "none" ? scene : null;
}

function programSceneUrl(account, profile) {
  // Render the active page directly in Electron. Nesting the animated music
  // canvas inside music-program.html caused offscreen Chromium to coalesce
  // iframe damage into ~1-3 meaningful paints per second even while FFmpeg
  // padded the output to 30 fps. NekoStreamAPP's proven desktop backend loads
  // its scene directly; use the same architecture here.
  if (activeProgramScene(account)) {
    // Starting Soon / BRB / Ending cards follow the same Music Performance
    // Mode: reduced effects stop their 60 Hz CSS animations server-side.
    const effects = profileVideo(profile).performance.effects;
    return `${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(account.twitchLogin)}/master${effects !== "full" ? `?effects=${effects}` : ""}`;
  }
  return musicSceneUrl(account, profile);
}

function musicWorkerSignature(account, profile) {
  return JSON.stringify({
    login:account.twitchLogin,
    profileId:profile?.id,
    rtmpKey:profile?.rtmpKey || null,
    canvasMode:profile?.canvasMode || "landscape",
    video:profileVideo(profile),
    visual:profile?.musicVisual || {},
    // currentScene is intentionally excluded: entering/leaving a Program
    // Scene is handled by navigating the running compositor to the new page
    // (see Music24Worker.update) rather than restarting the whole worker,
    // so switching scenes does not interrupt the live output.
  });
}

async function mediaApiPathReady(pathName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${MEDIAMTX_API}/v3/paths/list`, {
      cache:"no-store",
      signal:controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return (data.items || []).some(item => item.ready && item.name === pathName);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function probeRtmpPath(pathName, timeoutMs = RTMP_PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false;
    let stdout = "";
    let child;

    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child && !child.killed) child.kill("SIGKILL"); } catch {}
      resolve(Boolean(ok));
    };

    try {
      child = spawn(FFPROBE_BIN, [
        "-v", "error",
        "-rw_timeout", String(Math.max(1, timeoutMs) * 1000),
        "-show_entries", "stream=codec_type",
        "-of", "csv=p=0",
        `${RTMP_ORIGIN}/${pathName}`,
      ], { stdio:["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(false);
    }

    const timer = setTimeout(() => finish(false), timeoutMs + 250);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.on("error", () => finish(false));
    child.on("close", code => finish(code === 0 && /video|audio/i.test(stdout)));
  });
}

async function mediaPathReady(pathName) {
  const apiResult = await mediaApiPathReady(pathName);
  if (apiResult !== null) return apiResult;

  if (!apiFallbackLogged) {
    apiFallbackLogged = true;
    console.warn(`[music24] MediaMTX Control API unavailable at ${MEDIAMTX_API}; falling back to direct RTMP readiness probes`);
  }
  return probeRtmpPath(pathName);
}

async function waitForMediaPath(pathName, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!shuttingDown && Date.now() < deadline) {
    if (await mediaPathReady(pathName)) return true;
    await sleep(250);
  }
  return false;
}

function spawnSilenceFeed(accountId, profileId) {
  const streamName = `music-silence/${sanitizeSegment(accountId)}-${sanitizeSegment(profileId)}`;
  const outputUrl = `${RTMP_ORIGIN}/${streamName}`;
  const args = [
    "-hide_banner", "-loglevel", "warning", "-nostats", "-re",
    "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-g", "2", "-b:v", "32k",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-f", "flv", "-flvflags", "no_duration_filesize", "-rtmp_live", "live",
    outputUrl,
  ];
  const child = spawn(FFMPEG_BIN, args, { stdio:["ignore", "ignore", "pipe"] });
  child.stderr.on("data", chunk => {
    const line = chunk.toString().trim();
    if (line && /error|failed|cannot|refused|invalid/i.test(line)) {
      console.warn(`[music24:${accountId}:${profileId}] silence ffmpeg: ${line}`);
    }
  });
  return { child, outputUrl, streamName };
}

class Music24Worker {
  constructor(account, profile) {
    this.accountId = account.twitchUserId;
    this.account = account;
    this.profile = profile;
    this.signature = musicWorkerSignature(account, profile);
    this.silence = null;
    this.compositor = null;
    this.now = null;
    this.nowFetchedAt = 0;
    this.nowTimer = null;
    this.running = false;
    this.stopping = false;
    this.outputPath = null;
    this.phase = "idle";
    this.error = null;
  }

  update(account, profile) {
    this.account = account;
    this.profile = profile;
    if (this.compositor) this.compositor.navigate(programSceneUrl(account, profile)).catch(() => {});
  }

  getNow() {
    if (!this.now) return null;
    const now = { ...this.now };
    if (now.mode === "playing" && now.track) {
      now.positionS = Math.max(0, Number(now.positionS || 0) + (Date.now() - this.nowFetchedAt) / 1000);
    }
    return now;
  }

  musicFilePathFor(trackId) {
    const state = profileMusicState(this.account, this.profile);
    const track = state?.tracks.find(t => t.id === trackId);
    return track ? path.join(MUSIC_DIR, sanitizeSegment(this.accountId), state.profileId, track.filename) : null;
  }

  async pollNow() {
    try {
      const url = `${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(this.account.twitchLogin)}/music/${encodeURIComponent(this.profile.id)}/now.json`;
      const res = await fetch(url, { cache:"no-store" });
      if (res.ok) {
        const previousTrack = this.now?.track?.id || null;
        this.now = await res.json();
        this.nowFetchedAt = Date.now();
        this.scheduleTrackEndPoll();
        if ((this.now?.track?.id || null) !== previousTrack) this.compositor?.syncMusic?.();
      }
    } catch {}
  }

  // One request at the end of the current track instead of polling the whole
  // time. The engine also emits an in-process event on every advance.
  scheduleTrackEndPoll() {
    if (this.trackEndTimer) clearTimeout(this.trackEndTimer);
    this.trackEndTimer = null;
    const now = this.now;
    if (now?.mode !== "playing" || !(Number(now.durationS) > 0)) return;
    const remainingMs = Math.max(250, (Number(now.durationS) - Number(now.positionS || 0)) * 1000 + 300);
    this.trackEndTimer = setTimeout(() => { this.trackEndTimer = null; this.pollNow(); }, Math.min(remainingMs, 2 ** 31 - 1));
  }

  startNowPoll() {
    this.stopNowPoll();
    this.pollNow();
    this.nowTimer = setInterval(() => this.pollNow(), NOW_POLL_MS);
    this.offEvents = events.on(String(this.accountId), event => {
      if (event?.type === "music" && (!event.profileId || String(event.profileId) === String(this.profile?.id))) this.pollNow();
    });
  }

  stopNowPoll() {
    if (this.nowTimer) {
      clearInterval(this.nowTimer);
      this.nowTimer = null;
    }
    if (this.trackEndTimer) {
      clearTimeout(this.trackEndTimer);
      this.trackEndTimer = null;
    }
    if (this.offEvents) {
      try { this.offEvents(); } catch {}
      this.offEvents = null;
    }
  }

  // Auto quality is verified live: if the chosen tier cannot hold its render
  // rate (Chromium) or FFmpeg cannot take frames in realtime for ~30 s, the
  // tier is marked too heavy and the reconcile loop restarts one tier lower.
  startHealthWatch(video) {
    this.stopHealthWatch();
    if (!video?.autoTier) return;
    const graceMs = Number(process.env.MUSIC24_HEALTH_GRACE_MS || 20000);
    const intervalMs = Number(process.env.MUSIC24_HEALTH_INTERVAL_MS || 10000);
    const startedAt = Date.now();
    let strikes = 0, lastDropped = null;
    this.healthTimer = setInterval(() => {
      const s = this.compositor?.status?.();
      if (!s || s.state !== "running" || Date.now() - startedAt < graceMs) { lastDropped = s?.framesDropped ?? lastDropped; return; }
      const expectedRender = Math.min(video.renderFps, video.performance?.spectrumHz || video.renderFps);
      const dropped = lastDropped == null ? 0 : (s.framesDropped || 0) - lastDropped;
      lastDropped = s.framesDropped || 0;
      const slowRender = s.measuredRenderFps != null && s.measuredRenderFps < expectedRender * 0.55;
      const slowEncode = s.measuredEncodeFps != null && s.measuredEncodeFps < video.renderFps * 0.8;
      const dropping = dropped > video.renderFps * (intervalMs / 1000) * 0.1;
      strikes = slowRender || slowEncode || dropping ? strikes + 1 : 0;
      if (strikes >= 3) {
        this.stopHealthWatch();
        const reason = slowRender ? `browser ${s.measuredRenderFps}/${expectedRender} fps` : slowEncode ? `encoder ${s.measuredEncodeFps}/${video.renderFps} fps` : `${dropped} frames dropped`;
        if (hardwareProfile.markTooHeavy("music", video.autoTier, reason)) reconcile().catch(() => {});
      }
    }, intervalMs);
    this.healthTimer.unref?.();
  }

  stopHealthWatch() {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
  }

  runtimeStatus() {
    const compositor = this.compositor?.status?.() || null;
    const video = this.video || profileVideo(this.profile);
    const snapshot = monitor.sample();
    const mine = snapshot.components.filter(row => row.group === "music24" && row.name.includes(`music24-${this.accountId}-`));
    const measured = mine.filter(row => row.cpuPercent != null);
    return {
      encoder:compositor?.encoder || video.encoderLabel,
      encoderId:compositor?.encoderId || null,
      encoderPreference:video.encoderPreference,
      encoderFallbackReason:compositor?.encoderFallbackReason || null,
      gpuEncoding:!!compositor?.hardwareEncoder,
      chromiumGpu:!!video.gpuEnabled,
      resolution:`${video.width}x${video.height}`,
      width:video.width,
      height:video.height,
      fps:video.fps,
      renderFps:video.renderFps,
      measuredRenderFps:compositor?.measuredRenderFps ?? null,
      measuredEncodeFps:compositor?.measuredEncodeFps ?? null,
      performanceMode:video.performance?.mode,
      autoTier:video.autoTier || null,
      autoReason:video.autoReason || null,
      hostType:hardwareProfile.getHostProfile().hostType?.label || null,
      performanceRequested:video.performance?.requested,
      performanceLabel:video.performance?.label,
      spectrumHz:video.performance?.spectrumHz,
      progressHz:video.performance?.progressHz,
      effects:video.performance?.effects,
      cpuPercent:measured.length ? Math.round(measured.reduce((sum, row) => sum + row.cpuPercent, 0) * 10) / 10 : null,
      rssBytes:mine.reduce((sum, row) => sum + (row.rssBytes || 0), 0),
      components:mine.map(({ label, cpuPercent, rssBytes, meta }) => ({ label, cpuPercent, rssBytes, meta })),
      framesDropped:compositor?.framesDropped ?? 0,
    };
  }

  setStatus(state, error = null, extra = {}) {
    this.phase = state;
    this.error = error;
    lastStatus.set(String(this.accountId), {
      state,
      profileId:this.profile?.id || null,
      outputPath:this.outputPath || null,
      error,
      ...extra,
    });
  }

  async start() {
    if (this.running || this.stopping) return;

    const outputPath = profilePublishPath(this.profile);
    if (!outputPath) throw new Error("active Music profile has no valid RTMP key yet");

    this.running = true;
    this.outputPath = outputPath;
    this.setStatus("starting");
    this.startNowPoll();

    const startSilence = () => {
      if (!this.running || this.stopping) return;
      const feed = spawnSilenceFeed(this.accountId, this.profile.id);
      this.silence = feed;
      feed.child.once("exit", code => {
        if (this.silence?.child === feed.child) this.silence = null;
        if (this.running && !this.stopping && !shuttingDown) {
          console.warn(`[music24:${this.accountId}:${this.profile.id}] silence feed exited (${code}); restarting`);
          setTimeout(startSilence, 1500);
        }
      });
    };

    try {
      startSilence();
      const silencePath = this.silence?.streamName;
      if (!silencePath || !(await waitForMediaPath(silencePath))) {
        throw new Error(`MediaMTX did not receive the Music 24/7 audio feed at ${silencePath || "unknown path"}`);
      }

      if (!this.running || this.stopping) return;

      const outputUrl = `${RTMP_ORIGIN}/${outputPath}`;
      const video = profileVideo(this.profile);
      this.video = video;
      this.offSilenceDiagnostics = monitor.registerComponent(`music24:music24-${this.accountId}-${sanitizeSegment(this.profile.id)}:silence`, {
        label:"Music 24/7 · silence/keep-alive feed",
        group:"music24",
        tree:false,
        pids:() => [this.silence?.child?.pid].filter(Boolean),
      });
      this.compositor = new Compositor({
        ...compositorExtras(this.profile, video),
        accountId:`music24-${this.accountId}-${sanitizeSegment(this.profile.id)}`,
        pageUrl:programSceneUrl(this.account, this.profile),
        audioSourceUrl:`${RTMP_ORIGIN}/${silencePath}`,
        outputUrl,
        getMusicNow:() => this.getNow(),
        musicFilePathFor:id => this.musicFilePathFor(id),
        video,
        runtimeDir:path.join("/tmp", "castnexus-music24", sanitizeSegment(this.accountId), sanitizeSegment(this.profile.id)),
        logger:console,
        // Music 24/7 already has an always-on music/silence PCM producer.
        // Avoid a second audio input and amix so audio pacing cannot starve
        // the video pipeline on Electron.
        includeLiveAudio:false,
      });

      await this.compositor.start();
      if (!(await waitForMediaPath(outputPath))) {
        const status = this.compositor?.status?.();
        throw new Error(`Music 24/7 publisher did not become live on ${outputPath}${status?.error ? `: ${status.error}` : ""}`);
      }

      this.setStatus("live", null, { video });
      this.startHealthWatch(video);
      const enc = this.compositor?.status?.();
      console.log(`[music24:${this.accountId}:${this.profile.id}] ON AIR ${video.width}x${video.height}@${video.fps} (render ${video.renderFps} fps, ${video.performance.label}, ${enc?.encoder || video.encoderLabel}) -> ${outputPath}`);
    } catch (err) {
      this.setStatus("error", err.message);
      await this.stop({ preserveStatus:true });
      throw err;
    }
  }

  async stop({ preserveStatus = false } = {}) {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    this.stopNowPoll();
    this.stopHealthWatch();
    if (this.offSilenceDiagnostics) { try { this.offSilenceDiagnostics(); } catch {} this.offSilenceDiagnostics = null; }

    if (this.compositor) {
      try { await this.compositor.stop(); } catch {}
      this.compositor = null;
    }

    if (this.silence?.child) {
      const child = this.silence.child;
      child.removeAllListeners("exit");
      try { child.kill("SIGTERM"); } catch {}
      this.silence = null;
    }

    this.outputPath = null;
    if (!preserveStatus) this.setStatus("idle");
    this.stopping = false;
    console.log(`[music24:${this.accountId}:${this.profile?.id}] stopped`);
  }
}

// Music 24/7 streaming switch. Kept in memory only, so it is OFF after every
// dashboard/container restart until the user turns it on again (set
// MUSIC24_AUTOSTART=true to keep the old always-on behaviour).
const streamingSwitch = new Map();
function autostartDefault() {
  return String(process.env.MUSIC24_AUTOSTART || "").toLowerCase() === "true";
}
function streamingEnabled(accountId) {
  const key = String(accountId);
  return streamingSwitch.has(key) ? streamingSwitch.get(key) : autostartDefault();
}
function setStreaming(accountId, enabled) {
  streamingSwitch.set(String(accountId), !!enabled);
  if (serviceStarted && !shuttingDown) reconcile().catch(err => console.error("[music24] reconcile failed", err));
  return streamingEnabled(accountId);
}

function musicHasConsumer(account, profile) {
  if (String(process.env.MUSIC24_ALWAYS_ON || "").toLowerCase() === "true") return true;
  if (account.relayPushEnabled || account.recordingEnabled) return true;
  const bucket = account.destinationProfiles?.[bucketKey(profile.id)];
  const list = Array.isArray(bucket) ? bucket : (Array.isArray(account.destinations) ? account.destinations : []);
  return list.some(dest => dest?.enabled);
}

async function reconcile() {
  const state = readState();
  if (!state?.accounts) return;
  const desired = new Set();

  for (const account of Object.values(state.accounts)) {
    const profile = activeProfileFor(account);
    const musicState = profileMusicState(account, profile);
    const ready = profile?.mode === "music"
      && profile?.musicAutostart !== false
      && (musicState?.tracks.length || 0) > 0
      && validRtmpKey(profile?.rtmpKey)
      && account.twitchLogin;

    if (!ready) {
      // PC / console profiles: music is only background audio mixed into the
      // program - no 24/7 renderer, visualiser or encoder runs.
      if (account.twitchUserId && profile && profile.mode !== "music") lastStatus.set(String(account.twitchUserId), { state:"inactive", profileId:profile.id, outputPath:null, error:null, reason:"The active profile is not a Music profile - music plays only as background audio, Music 24/7 is not streaming." });
      continue;
    }
    if (!streamingEnabled(account.twitchUserId)) {
      lastStatus.set(String(account.twitchUserId), { state:"off", profileId:profile.id, outputPath:null, error:null, reason:"Music 24/7 streaming is switched off. Turn it on to go on air (it switches off again after a restart)." });
      continue;
    }
    // Do not render/encode 24/7 for nobody: run only while something consumes
    // the stream (an enabled destination, relay push or recording), unless
    // MUSIC24_ALWAYS_ON=true (e.g. only watched through public playback).
    if (!musicHasConsumer(account, profile)) {
      lastStatus.set(String(account.twitchUserId), { state:"standby", profileId:profile.id, outputPath:null, error:null, reason:"No destination is enabled for this Music profile - Music 24/7 is paused to save CPU. Enable a destination (or set MUSIC24_ALWAYS_ON=true) to go on air." });
      continue;
    }

    const accountId = String(account.twitchUserId);
    desired.add(accountId);
    const sig = musicWorkerSignature(account, profile);
    let worker = workers.get(accountId);

    if (worker && worker.signature !== sig) {
      await worker.stop();
      workers.delete(accountId);
      worker = null;
    }

    if (!worker) {
      worker = new Music24Worker(account, profile);
      workers.set(accountId, worker);
      worker.start().catch(async err => {
        console.error(`[music24:${accountId}:${profile.id}] start failed: ${err.message}`);
        lastStatus.set(accountId, {
          state:"error",
          profileId:profile.id,
          outputPath:worker.outputPath || null,
          error:err.message,
        });
        if (workers.get(accountId) === worker) workers.delete(accountId);
        try { await worker.stop({ preserveStatus:true }); } catch {}
      });
    } else {
      worker.update(account, profile);
    }
  }

  for (const [accountId, worker] of [...workers.entries()]) {
    if (!desired.has(accountId)) {
      await worker.stop();
      workers.delete(accountId);
    }
  }
}

function statusFor(accountId) {
  const key = String(accountId);
  const worker = workers.get(key);
  if (worker) {
    return {
      state:worker.phase || "starting",
      profileId:worker.profile?.id || null,
      outputPath:worker.outputPath || null,
      error:worker.error || null,
      running:!!worker.running,
      runtime:worker.runtimeStatus(),
      streaming:streamingEnabled(key),
    };
  }
  const last = lastStatus.get(key);
  if (last) return { ...last, streaming:streamingEnabled(key) };
  return {
    streaming:streamingEnabled(key),
    state:serviceStarted ? "idle" : "worker-offline",
    profileId:null,
    outputPath:null,
    error:null,
    running:false,
  };
}

function startMusic24() {
  if (serviceStarted) return { started:true, alreadyRunning:true };
  shuttingDown = false;
  serviceStarted = true;
  console.log(`[music24] watching ${STATE_FILE} for active profile-scoped 24/7 music`);
  // Test the hardware BEFORE the first stream starts, so Auto pushes the best
  // quality this host can hold from the first frame (cached after one run).
  let hardwareReady = false;
  hardwareProfile.ensureHostProfile().catch(() => null).finally(() => {
    hardwareReady = true;
    if (!shuttingDown) reconcile().catch(err => console.error("[music24] initial reconcile failed", err));
  });
  reconcileTimer = setInterval(() => { if (hardwareReady) reconcile().catch(err => console.error("[music24] reconcile failed", err)); }, POLL_MS);
  return { started:true, alreadyRunning:false };
}

async function shutdown(signal = "shutdown", { exit = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  serviceStarted = false;
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  console.log(`[music24] ${signal} received; stopping workers`);
  for (const worker of workers.values()) {
    try { await worker.stop(); } catch {}
  }
  workers.clear();
  if (exit) process.exit(0);
}

if (require.main === module) {
  if (String(process.env.MUSIC24_STANDALONE || "").toLowerCase() !== "true") {
    console.log("[music24] standalone sidecar is disabled; Music 24/7 now runs inside the CastNexus dashboard runtime. Set MUSIC24_STANDALONE=true only for a custom legacy deployment.");
  } else {
    process.on("SIGINT", () => shutdown("SIGINT", { exit:true }));
    process.on("SIGTERM", () => shutdown("SIGTERM", { exit:true }));
    process.on("unhandledRejection", err => console.error("[music24] unhandled rejection", err));
    startMusic24();
  }
}

module.exports = {
  startMusic24,
  shutdown,
  reconcile,
  statusFor,
  Music24Worker,
  mediaApiPathReady,
  probeRtmpPath,
  mediaPathReady,
  waitForMediaPath,
  profileMusicState,
  musicSceneUrl,
  activeProgramScene,
  programSceneUrl,
  musicWorkerSignature,
  musicHasConsumer,
  streamingEnabled,
  setStreaming,
  musicPerformanceSettings,
  profileVideo,
  compositorExtras,
};
