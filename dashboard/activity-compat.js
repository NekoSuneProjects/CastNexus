"use strict";

// Discord Activity "compatibility" rendition: VP9 video + Opus audio.
//
// Discord's desktop app decodes H.264 only through the GPU. With Hardware
// Acceleration off (or a GPU/driver that can't decode the stream) the viewer
// gets "video decoder initialization failed" while everyone else plays fine.
// VP9 and Opus are decoded in software by every Discord/Chromium build, so the
// Activity falls back to this rendition for exactly those viewers.
//
// The rendition is made ON DEMAND: the first viewer that needs it starts one
// FFmpeg per channel (public/<login> -> activity-vp9/<login> over RTSP into
// MediaMTX, which serves it as LL-HLS on /hls/activity-vp9/<login>/). Viewers
// keep it alive by polling; it stops when nobody has asked for it for a while.
//
//   DISCORD_ACTIVITY_COMPAT=true|false   (default true)
//   DISCORD_ACTIVITY_COMPAT_HEIGHT=720   DISCORD_ACTIVITY_COMPAT_FPS=30
//   DISCORD_ACTIVITY_COMPAT_BITRATE=2500k  DISCORD_ACTIVITY_COMPAT_MAX=2 (channels at once)

const { spawn: defaultSpawn } = require("node:child_process");

const PATH_PREFIX = "activity-vp9";

function compatConfig(env = process.env) {
  const int = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : d; };
  const bitrate = /^\d+(\.\d+)?[kKmM]?$/.test(String(env.DISCORD_ACTIVITY_COMPAT_BITRATE || "")) ? String(env.DISCORD_ACTIVITY_COMPAT_BITRATE) : "2500k";
  return {
    enabled:String(env.DISCORD_ACTIVITY_COMPAT ?? "true").trim().toLowerCase() !== "false",
    height:int(env.DISCORD_ACTIVITY_COMPAT_HEIGHT, 720, 240, 1080),
    fps:int(env.DISCORD_ACTIVITY_COMPAT_FPS, 30, 10, 60),
    bitrate,
    max:int(env.DISCORD_ACTIVITY_COMPAT_MAX, 2, 1, 10),
    idleMs:int(env.DISCORD_ACTIVITY_COMPAT_IDLE_MS, 45000, 10000, 600000),
  };
}

function compatPath(login) { return `${PATH_PREFIX}/${String(login).toLowerCase()}`; }

function ffmpegArgs({ login, rtmpOrigin, rtspOrigin, config }) {
  const kbps = parseFloat(config.bitrate) * (/m$/i.test(config.bitrate) ? 1000 : 1);
  return [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "nobuffer", "-i", `${rtmpOrigin}/public/${login}`,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `scale=-2:'min(${config.height},ih)':flags=bilinear,fps=${config.fps},format=yuv420p`,
    // Realtime VP9: fastest preset, row multithreading, no lookahead.
    "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-tile-columns", "2",
    "-lag-in-frames", "0", "-error-resilient", "1", "-static-thresh", "0",
    "-b:v", config.bitrate, "-maxrate", `${Math.round(kbps * 1.2)}k`, "-bufsize", `${Math.round(kbps * 2)}k`,
    "-g", String(config.fps * 2), "-keyint_min", String(config.fps * 2),
    "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-f", "rtsp", "-rtsp_transport", "tcp", `${rtspOrigin}/${compatPath(login)}`,
  ];
}

function createCompatManager({
  env = process.env,
  rtmpOrigin = process.env.MEDIA_RTMP_ORIGIN || "rtmp://127.0.0.1:1935",
  rtspOrigin = process.env.MEDIA_RTSP_ORIGIN || "rtsp://127.0.0.1:8554",
  mediamtxApi = process.env.MEDIAMTX_API || "http://127.0.0.1:9997",
  spawnImpl = defaultSpawn,
  fetchImpl = (...args) => global.fetch(...args),
  log = (...args) => console.log(...args),
  now = () => Date.now(),
} = {}) {
  const config = compatConfig(env);
  const jobs = new Map(); // login -> { child, startedAt, lastUsed, ready, checkedAt }

  function stop(login, why) {
    const job = jobs.get(login);
    if (!job) return;
    jobs.delete(login);
    try { job.child.kill("SIGTERM"); } catch {}
    log(`[discord-activity] VP9 compatibility stream for ${login} stopped (${why})`);
  }

  function start(login) {
    const child = spawnImpl("ffmpeg", ffmpegArgs({ login, rtmpOrigin, rtspOrigin, config }), { stdio:["ignore", "ignore", "pipe"] });
    const job = { child, startedAt:now(), lastUsed:now(), ready:false, checkedAt:0, stderr:"" };
    child.stderr?.on("data", d => { job.stderr = (job.stderr + d).slice(-2000); });
    child.on("exit", code => {
      if (jobs.get(login) !== job) return;
      jobs.delete(login);
      log(`[discord-activity] VP9 compatibility stream for ${login} exited (code ${code})${job.stderr ? `: ${job.stderr.trim().split(/\r?\n/).slice(-2).join(" | ")}` : ""}`);
    });
    child.on("error", err => { if (jobs.get(login) === job) { jobs.delete(login); log(`[discord-activity] could not start FFmpeg for the VP9 stream: ${err.message}`); } });
    jobs.set(login, job);
    log(`[discord-activity] VP9 compatibility stream for ${login} started (${config.height}p${config.fps} ${config.bitrate}) - a viewer's Discord can't decode H.264`);
    return job;
  }

  async function pathReady(login) {
    try {
      const r = await fetchImpl(`${mediamtxApi}/v3/paths/get/${encodeURIComponent(PATH_PREFIX)}/${encodeURIComponent(login)}`);
      if (!r.ok) return false;
      return !!(await r.json()).ready;
    } catch { return false; }
  }

  // Called by viewers that need VP9 (also the keepalive).
  async function ensure(login) {
    if (!config.enabled) return { enabled:false, ready:false };
    login = String(login).toLowerCase();
    let job = jobs.get(login);
    if (!job) {
      if (jobs.size >= config.max) return { enabled:true, ready:false, busy:true, error:`at most ${config.max} VP9 compatibility streams can run at once (DISCORD_ACTIVITY_COMPAT_MAX)` };
      job = start(login);
    }
    job.lastUsed = now();
    if (!job.ready && now() - job.checkedAt > 800) { job.checkedAt = now(); job.ready = await pathReady(login); }
    return { enabled:true, ready:job.ready, path:compatPath(login), url:`/hls/${compatPath(login)}/index.m3u8` };
  }

  const reaper = setInterval(() => {
    for (const [login, job] of jobs) if (now() - job.lastUsed > config.idleMs) stop(login, "no viewer needs it");
  }, 5000);
  reaper.unref?.();

  function shutdown() { clearInterval(reaper); for (const login of [...jobs.keys()]) stop(login, "shutdown"); }

  return { ensure, stop, shutdown, config, running:() => [...jobs.keys()] };
}

module.exports = { createCompatManager, compatConfig, compatPath, ffmpegArgs, PATH_PREFIX };
