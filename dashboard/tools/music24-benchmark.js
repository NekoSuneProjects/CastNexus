#!/usr/bin/env node
"use strict";

// Music 24/7 renderer benchmark.
//
// Runs the real Music 24/7 scene page + the real Compositor class (Chromium
// screencast -> FFmpeg encode) against a synthetic track, publishes to a null
// sink instead of MediaMTX, and measures CPU/RAM per process class for a fixed
// window. Use it to compare before/after on the SAME machine:
//
//   node tools/music24-benchmark.js --encoder cpu --width 1920 --height 1080 --fps 30 --mode balanced
//   docker exec -it castnexus-dashboard node tools/music24-benchmark.js --encoder auto --mode auto
//
// Options:
//   --encoder auto|cpu|nvenc|qsv|vaapi   (sets CASTNEXUS_VIDEO_ENCODER)
//   --mode    auto|max|balanced|low|ultra (Music Performance Mode; ignored by old builds)
//   --width/--height/--fps               requested render profile
//   --render-fps N                       Music render FPS override
//   --chromium-gpu true|false|auto       (sets COMPOSITOR_GPU; default false = VPS-like SwiftShader)
//   --warmup S  --seconds S              warm-up and measurement windows
//   --label TEXT  --json FILE            tag and optionally write the result as JSON

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const opts = {
  encoder:arg("encoder", "cpu"),
  mode:arg("mode", "auto"),
  width:Number(arg("width", 1920)),
  height:Number(arg("height", 1080)),
  fps:Number(arg("fps", 30)),
  renderFps:arg("render-fps", null),
  chromiumGpu:arg("chromium-gpu", "false"),
  warmup:Number(arg("warmup", 12)),
  seconds:Number(arg("seconds", 30)),
  label:arg("label", "run"),
  json:arg("json", null),
  cpuSafe:arg("cpu-safe", "false"),
};

process.env.CASTNEXUS_VIDEO_ENCODER = opts.encoder;
process.env.COMPOSITOR_GPU = opts.chromiumGpu;
process.env.CASTNEXUS_CPU_SAFE_MODE = opts.cpuSafe;
process.env.MUSIC24_WIDTH = String(opts.width);
process.env.MUSIC24_HEIGHT = String(opts.height);
process.env.MUSIC24_FPS = String(opts.fps);
if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
  const candidates = process.platform === "win32"
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) process.env.PUPPETEER_EXECUTABLE_PATH = found;
}

const root = path.join(__dirname, "..");
const express = require("express");
const { createOverlayRouter } = require(path.join(root, "overlays"));
const events = require(path.join(root, "events"));
const music24 = require(path.join(root, "music24"));
const { Compositor } = require(path.join(root, "compositor"));
const { detectEncoder } = require(path.join(root, "gpu-encoder"));
const { safeCanvas } = require(path.join(root, "rtmp-pipeline"));
const monitor = require(path.join(root, "resource-monitor"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "castnexus-bench-"));
const audioPath = path.join(work, "track.mp3");
const gen = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "anoisesrc=d=900:c=pink:a=0.3",
  "-f", "lavfi", "-i", "sine=f=220:d=900",
  "-filter_complex", "[0:a][1:a]amix=inputs=2,volume='0.6+0.4*sin(2*PI*t*0.8)':eval=frame[a]",
  "-map", "[a]", "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", audioPath,
], { encoding:"utf8" });
if (gen.status !== 0) { console.error(gen.stderr); process.exit(1); }

const profile = {
  id:"bench",
  name:"Benchmark",
  mode:"music",
  canvasMode:opts.height > opts.width ? "vertical" : "landscape",
  rtmpKey:"benchbenchbenchbenchbench",
  musicVisual:{ accent:"#00f0ff", station:"Benchmark Radio", title:"CastNexus Radio" },
  musicPerformance:{ mode:opts.mode, fps:opts.fps, width:opts.width, height:opts.height, encoder:opts.encoder, ...(opts.renderFps ? { renderFps:Number(opts.renderFps) } : {}) },
};
const track = { id:"t1", title:"Benchmark Track With A Reasonably Long Title", artist:"CastNexus Bench", filename:"track.mp3", durationS:900 };
const account = { twitchUserId:"bench", twitchLogin:"bench", displayName:"Bench", overlayConfig:{}, overlays:[], musicProfiles:{ bench:{ tracks:[track], settings:{ volume:.7 } } } };
const startedAt = Date.now();
const now = () => ({ mode:"playing", track:{ id:track.id, title:track.title, artist:track.artist, coverEmbedded:false }, positionS:(Date.now() - startedAt) / 1000, durationS:track.durationS, volume:.7 });

const app = express();
app.use("/overlay", createOverlayRouter({
  getAccountByLogin:login => (login === "bench" ? account : null),
  musicDir:work,
  isLiveFn:() => true,
  subscribeEvents:events.subscribe,
  getMusicNow:() => now(),
  getMusicState:() => ({ profileId:"bench", tracks:[track], settings:{ volume:.7 } }),
  getActiveProfile:() => profile,
  musicFilePathFor:() => audioPath,
}));

function legacyVideo() {
  const detected = detectEncoder();
  return { ...safeCanvas(profile.canvasMode, { hardwareEncoder:detected.hardware, width:opts.width, height:opts.height, fps:opts.fps }), bitrate:"3500k", maxrate:"3500k", bufsize:"7000k" };
}

async function main() {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  process.env.DASHBOARD_INTERNAL_ORIGIN = `http://127.0.0.1:${port}`;
  const origin = `http://127.0.0.1:${port}`;

  const video = typeof music24.profileVideo === "function" ? music24.profileVideo(profile) : legacyVideo();
  const scenePath = new URL(music24.musicSceneUrl(account, profile)).pathname + new URL(music24.musicSceneUrl(account, profile)).search;
  const extras = typeof music24.compositorExtras === "function" ? music24.compositorExtras(profile, video) : {};
  const compositor = new Compositor({
    accountId:"bench",
    pageUrl:`${origin}${scenePath}`,
    audioSourceUrl:null,
    outputUrl:process.platform === "win32" ? "NUL" : "/dev/null",
    getMusicNow:now,
    musicFilePathFor:() => audioPath,
    video,
    runtimeDir:path.join(work, "runtime"),
    logger:{ log(){}, warn:(...a) => console.warn(...a), error:(...a) => console.error(...a) },
    includeLiveAudio:false,
    ...extras,
  });

  let screencastFrames = 0;
  await compositor.start();
  if (compositor.client) compositor.client.on("Page.screencastFrame", () => { screencastFrames++; });
  await new Promise(resolve => setTimeout(resolve, opts.warmup * 1000));

  const frames0 = compositor.frameCount, sc0 = screencastFrames;
  const renderStats0 = compositor.status?.().renderFrames ?? null;
  const measured = await monitor.measureTree(process.pid, opts.seconds * 1000, {
    classify:row => {
      if (row.pid === compositor.ffmpeg?.pid) return "ffmpeg-encoder";
      const name = String(row.comm || "").toLowerCase();
      if (name.includes("ffmpeg")) return "ffmpeg-audio";
      if (name.includes("chrome") || name.includes("chromium") || name.includes("msedge")) return "chromium";
      return name || "other";
    },
  });
  const status = compositor.status();
  const result = {
    label:opts.label,
    date:new Date().toISOString(),
    platform:`${process.platform}/${process.arch}`,
    cpuModel:os.cpus()[0]?.model,
    requested:{ width:opts.width, height:opts.height, fps:opts.fps, mode:opts.mode, encoder:opts.encoder, chromiumGpu:opts.chromiumGpu },
    effective:{ width:video.width, height:video.height, outputFps:video.fps, renderFps:video.renderFps ?? video.fps, encoder:status.encoder, hardwareEncoder:status.hardwareEncoder },
    framesToEncoderPerSec:Math.round((compositor.frameCount - frames0) / opts.seconds * 10) / 10,
    chromiumFramesPerSec:compositor.client ? Math.round((screencastFrames - sc0) / opts.seconds * 10) / 10 : (renderStats0 != null ? Math.round(((status.renderFrames ?? 0) - renderStats0) / opts.seconds * 10) / 10 : null),
    framesDropped:status.framesDropped,
    cpu:measured,
  };
  await compositor.stop();
  server.close();
  try { fs.rmSync(work, { recursive:true, force:true }); } catch {}
  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (opts.json) fs.writeFileSync(opts.json, text);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
