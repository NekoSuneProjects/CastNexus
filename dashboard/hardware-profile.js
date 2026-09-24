"use strict";

// Host hardware profile: "what can this machine stream, before we go live?"
//
// Runs once (a few seconds) and is cached in data/host-profile.json, keyed by
// a hardware fingerprint so a new CPU/GPU/FFmpeg re-tests automatically:
//
//   1. host type    Raspberry Pi / ARM board, VPS (hypervisor), desktop PC
//   2. encoder      the existing real-encode probe (NVENC/QSV/VAAPI/AMF/x264)
//   3. Chromium GPU does headless Chromium REALLY rasterise on a GPU, or has
//                   it silently fallen back to SwiftShader? (read from WebGL)
//   4. CPU speed    ffmpeg -benchmark of a 1080p x264 encode = core-seconds
//                   per frame on THIS CPU
//
// The recommendation walks quality tiers from best to lightest, estimating the
// cores each tier needs from the measured CPU speed, and picks the first that
// fits the host's CPU budget (Pi 70%, VPS 50%, desktop 35% - a desktop is
// usually also running the game and OBS). A GPU desktop gets 1080p (60 fps for
// programs when affordable), a 6-core CPU-only VPS the best resolution/FPS that
// stays around half the machine, and a Pi something that stays realtime.
//
// While live, Music 24/7 checks the real render/encode rate; a tier that cannot
// keep up is marked too heavy (markTooHeavy) and the worker restarts one tier
// lower. The choice is remembered in the cache.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const PROFILE_VERSION = 2;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "data", "state.json");
const CACHE_FILE = process.env.CASTNEXUS_HOST_PROFILE_FILE || path.join(path.dirname(STATE_FILE), "host-profile.json");

// Calibration measured with tools/music24-benchmark.js on an i7-6700K:
// Chromium (SwiftShader) spends ~6x the x264-ultrafast cost per 1080p frame
// with reduced effects, and ~44x with full 60 Hz effects; decoding the MJPEG
// capture in FFmpeg costs ~0.35x. With real GPU rasterisation (GTX 980 Ti,
// ANGLE/D3D11) Chromium measured ~0.7x the software cost for the same scene.
const RENDER_FACTOR = { reduced:6.1, minimal:5.8, full:44 };
const MJPEG_DECODE_FACTOR = 0.35;
const GPU_RENDER_DISCOUNT = 0.7;
const HW_ENCODE_CORES_PER_30FPS = 0.06; // upload/driver overhead of NVENC/QSV/VAAPI
const REFERENCE_X264_1080P = 0.009; // core-seconds per frame, ultrafast, i7-6700K

// Share of ALL cores Music 24/7 / a program renderer may plan to use.
const DEFAULT_BUDGET = { pi:0.7, vps:0.5, desktop:0.35, unknown:0.45 };

// Maximum (full 60 Hz effects) is never auto-selected: even with a real GPU the
// CDP screencast delivered <1 unique frame/s of the full-effects scene while
// Chromium burned ~3 cores. It stays a manual choice.
const MUSIC_TIERS = [
  { id:"1080p30-balanced", width:1920, height:1080, fps:30, mode:"balanced" },
  { id:"1080p30-low", width:1920, height:1080, fps:30, mode:"low" },
  { id:"720p30-balanced", width:1280, height:720, fps:30, mode:"balanced" },
  { id:"720p30-low", width:1280, height:720, fps:30, mode:"low" },
  { id:"720p30-ultra", width:1280, height:720, fps:30, mode:"ultra" },
  { id:"540p30-low", width:960, height:540, fps:30, mode:"low" },
  { id:"540p20-low", width:960, height:540, fps:20, mode:"low" },
  { id:"540p20-ultra", width:960, height:540, fps:20, mode:"ultra" },
  { id:"360p20-ultra", width:640, height:360, fps:20, mode:"ultra" },
];
const PROGRAM_TIERS = [
  { id:"1080p60", width:1920, height:1080, fps:60 },
  { id:"1080p30", width:1920, height:1080, fps:30 },
  { id:"720p60", width:1280, height:720, fps:60 },
  { id:"720p30", width:1280, height:720, fps:30 },
  { id:"540p30", width:960, height:540, fps:30 },
  { id:"540p20", width:960, height:540, fps:20 },
];
// Mirrors performance-modes.js presets (render fps / page damage rate / effects).
const MODE_RATES = {
  max:{ render:null, damage:60, effects:"full" },
  balanced:{ render:24, damage:24, effects:"reduced" },
  low:{ render:20, damage:12, effects:"reduced" },
  ultra:{ render:12, damage:10, effects:"minimal" },
};

let current = null;
let probing = null;

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

// ------------------------------------------------------------ host type
function detectHostType({ platform = process.platform, arch = process.arch, files = readText } = {}) {
  const model = files("/proc/device-tree/model").replace(/\0/g, "").trim();
  if (platform === "linux" && (/raspberry pi/i.test(model) || ((arch === "arm64" || arch === "arm") && model))) {
    return { type:"pi", label:/raspberry pi/i.test(model) ? model : `ARM board${model ? ` (${model})` : ""}`, virtual:false };
  }
  if (platform === "linux") {
    const vendor = `${files("/sys/class/dmi/id/sys_vendor")} ${files("/sys/class/dmi/id/product_name")} ${files("/sys/class/dmi/id/board_vendor")}`.trim();
    const cpuinfo = files("/proc/cpuinfo");
    const hypervisor = /^flags\s*:.*\bhypervisor\b/m.test(cpuinfo);
    const cloud = /(kvm|qemu|vmware|xen|amazon|ec2|google|digitalocean|droplet|hetzner|linode|akamai|vultr|ovh|openstack|microsoft corporation|virtual machine|bochs|parallels|oracle|scaleway|contabo)/i.exec(vendor);
    if (hypervisor || cloud) return { type:"vps", label:`VPS / virtual machine${cloud ? ` (${cloud[1]})` : ""}`, virtual:true };
    if (arch === "arm64" || arch === "arm") return { type:"pi", label:"ARM board", virtual:false };
    return { type:"desktop", label:"Linux PC / server", virtual:false };
  }
  if (platform === "win32") return { type:"desktop", label:"Windows PC", virtual:false };
  if (platform === "darwin") return { type:"desktop", label:"Mac", virtual:false };
  return { type:"unknown", label:platform, virtual:false };
}

function fingerprint(encoderId) {
  const cpu = os.cpus()[0]?.model || "cpu";
  return JSON.stringify({ v:PROFILE_VERSION, cpu, cores:os.cpus().length, arch:process.arch, platform:process.platform, ffmpeg:FFMPEG_BIN, enc:encoderId, gpuEnv:process.env.COMPOSITOR_GPU || "auto", chromium:process.env.PUPPETEER_EXECUTABLE_PATH || "" });
}

// --------------------------------------------------------------- probes
function runFfmpegBenchmark(args, timeoutMs = 30000) {
  return new Promise(resolve => {
    let err = "";
    let child;
    try { child = spawn(FFMPEG_BIN, ["-hide_banner", "-nostats", "-benchmark", ...args], { stdio:["ignore", "ignore", "pipe"] }); }
    catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stderr.on("data", d => { err += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", code => {
      clearTimeout(timer);
      const m = /bench:\s*utime=([\d.]+)s\s*stime=([\d.]+)s\s*rtime=([\d.]+)s/.exec(err);
      resolve(code === 0 && m ? { cpu:Number(m[1]) + Number(m[2]), wall:Number(m[3]) } : null);
    });
  });
}

// Core-seconds per 1080p frame for x264 ultrafast on this CPU (generator
// cost subtracted with a rawvideo baseline run).
async function probeX264(frames = 90) {
  const src = ["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30", "-frames:v", String(frames)];
  const base = await runFfmpegBenchmark([...src, "-c:v", "rawvideo", "-f", "null", "-"]);
  // Best of two runs: the probe often runs while the dashboard itself is
  // starting up, and one noisy sample should not drop the host a tier.
  const encodeArgs = [...src, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-threads", "2", "-f", "null", "-"];
  const runs = [await runFfmpegBenchmark(encodeArgs), await runFfmpegBenchmark(encodeArgs)].filter(Boolean);
  if (!runs.length) return null;
  const x264 = runs.reduce((best, run) => (run.cpu < best.cpu ? run : best));
  const cpu = Math.max(0.0005 * frames, x264.cpu - (base?.cpu || 0));
  return { coreSecondsPerFrame:cpu / frames, realtimeFps:frames / Math.max(0.001, x264.wall), frames };
}

function softwareRenderer(renderer) {
  return /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen|disabled/i.test(String(renderer || ""));
}

// Does headless Chromium actually get a GPU? Launch it with the GPU flags the
// compositor would use and read the WebGL renderer string.
async function probeChromiumGpu({ timeoutMs = 20000 } = {}) {
  const env = String(process.env.COMPOSITOR_GPU || "auto").toLowerCase();
  if (env === "false") return { available:false, renderer:null, reason:"COMPOSITOR_GPU=false" };
  if (String(process.env.CASTNEXUS_INSTALL_TYPE || "").toLowerCase() === "electron") {
    // Electron's own Chromium uses the desktop GPU when the OS provides one.
    return { available:process.platform !== "linux" || fs.existsSync("/dev/dri"), renderer:"electron", reason:"desktop Electron runtime" };
  }
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
  if (!fs.existsSync(execPath)) return { available:false, renderer:null, reason:`browser not found at ${execPath}` };
  let browser;
  const timer = new Promise(resolve => setTimeout(() => resolve({ available:false, renderer:null, reason:"GPU probe timed out" }), timeoutMs));
  const work = (async () => {
    const puppeteer = require("puppeteer-core");
    const { buildChromiumGpuArgs } = require("./compositor");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "castnexus-gpu-probe-"));
    try {
      browser = await puppeteer.launch({ executablePath:execPath, headless:"new", userDataDir:dir, args:["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--mute-audio", ...buildChromiumGpuArgs(true)] });
      const page = await browser.newPage();
      const renderer = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl) return "no-webgl";
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      });
      return { available:!softwareRenderer(renderer) && renderer !== "no-webgl", renderer, reason:null };
    } finally {
      try { await browser?.close(); } catch {}
      try { fs.rmSync(dir, { recursive:true, force:true }); } catch {}
    }
  })().catch(error => ({ available:false, renderer:null, reason:error.message }));
  const result = await Promise.race([work, timer]);
  if (result.reason === "GPU probe timed out") { try { browser?.process?.()?.kill("SIGKILL"); } catch {} }
  return result;
}

// ------------------------------------------------------------ estimates
function pixelScale(width, height) { return (width * height) / (1920 * 1080); }

// Cores a Music 24/7 tier needs on this host.
function estimateMusicCores(tier, host) {
  const E = host.cpu.coreSecondsPerFrame;
  const px = pixelScale(tier.width, tier.height);
  const rates = MODE_RATES[tier.mode];
  const render = Math.min(tier.fps, rates.render || tier.fps);
  const damage = Math.min(render, rates.damage);
  const renderCost = RENDER_FACTOR[rates.effects] * E * px * damage * (host.chromiumGpu ? GPU_RENDER_DISCOUNT : 1);
  const decode = MJPEG_DECODE_FACTOR * E * px * render;
  const encode = host.hardwareEncoder ? HW_ENCODE_CORES_PER_30FPS * (tier.fps / 30) : E * px * tier.fps * 1.1;
  return Math.round((renderCost + decode + encode + 0.05) * 100) / 100;
}

// Cores for an Overlay Studio program (live gameplay video + overlays): the
// page changes every frame and Chromium also decodes the WebRTC gameplay.
function estimateProgramCores(tier, host) {
  const E = host.cpu.coreSecondsPerFrame;
  const px = pixelScale(tier.width, tier.height);
  const render = RENDER_FACTOR.reduced * E * px * tier.fps * (host.chromiumGpu ? GPU_RENDER_DISCOUNT : 1);
  const videoDecode = 1.5 * E * px * tier.fps * (host.chromiumGpu ? 0.3 : 1);
  const decode = MJPEG_DECODE_FACTOR * E * px * tier.fps;
  const encode = host.hardwareEncoder ? HW_ENCODE_CORES_PER_30FPS * (tier.fps / 30) : E * px * tier.fps * 1.1;
  return Math.round((render + videoDecode + decode + encode + 0.1) * 100) / 100;
}

function budgetFor(host) {
  const override = Number(process.env.CASTNEXUS_AUTO_CPU_BUDGET);
  const share = override > 0 && override <= 1 ? override : (DEFAULT_BUDGET[host.hostType?.type] || DEFAULT_BUDGET.unknown);
  return { share, cores:Math.max(0.5, share * host.cores) };
}

function pick(tiers, estimate, host, kind) {
  const budget = budgetFor(host);
  const heavy = new Set(host.tooHeavy?.[kind] || []);
  const allowed = tiers.filter(t => !heavy.has(t.id));
  const evaluated = allowed.map(t => ({ ...t, cores:estimate(t, host) }));
  const chosen = evaluated.find(t => t.cores <= budget.cores) || evaluated[evaluated.length - 1] || tiers[tiers.length - 1];
  return { ...chosen, budgetCores:Math.round(budget.cores * 100) / 100, budgetShare:budget.share, candidates:evaluated.map(({ id, cores }) => ({ id, cores })) };
}

// ---------------------------------------------------------- the profile
function fallbackProfile(encoder) {
  // Used before the first probe finishes: the old behaviour (hardware
  // encoder => 1080p, otherwise the CPU-safe clamp) so nothing regresses.
  const hostType = detectHostType();
  const host = { version:PROFILE_VERSION, probed:false, hostType, cores:os.cpus().length, cpuModel:os.cpus()[0]?.model || "", hardwareEncoder:!!encoder?.hardware, encoder:encoder?.label || "CPU · x264", encoderId:encoder?.id || "libx264", chromiumGpu:false, chromium:{ available:false, renderer:null, reason:"not probed yet" }, cpu:{ coreSecondsPerFrame:REFERENCE_X264_1080P * (hostType.type === "pi" ? 6 : 1.4) }, tooHeavy:{} };
  return finalise(host);
}

function finalise(host) {
  host.recommendations = {
    music:pick(MUSIC_TIERS, estimateMusicCores, host, "music"),
    program:pick(PROGRAM_TIERS, estimateProgramCores, host, "program"),
  };
  host.cpuSpeedVsReference = Math.round((REFERENCE_X264_1080P / host.cpu.coreSecondsPerFrame) * 100) / 100;
  return host;
}

function loadCache(fp) {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return data?.fingerprint === fp && data.version === PROFILE_VERSION ? data : null;
  } catch { return null; }
}

function saveCache(host) {
  try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive:true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(host, null, 2)); } catch {}
}

async function runProbe({ force = false, logger = console } = {}) {
  const { detectEncoder } = require("./gpu-encoder");
  const encoder = detectEncoder();
  const fp = fingerprint(encoder.id);
  if (!force) {
    const cached = loadCache(fp);
    if (cached) return (current = finalise(cached));
  }
  const started = Date.now();
  const [cpu, chromium] = [await probeX264(), await probeChromiumGpu()];
  const previous = loadCache(fp);
  const host = {
    version:PROFILE_VERSION,
    fingerprint:fp,
    probed:true,
    probedAt:new Date().toISOString(),
    probeMs:Date.now() - started,
    hostType:detectHostType(),
    cores:os.cpus().length,
    cpuModel:os.cpus()[0]?.model || "",
    ramBytes:os.totalmem(),
    hardwareEncoder:!!encoder.hardware,
    encoder:encoder.label,
    encoderId:encoder.id,
    chromiumGpu:!!chromium.available,
    chromium,
    cpu:cpu || { coreSecondsPerFrame:REFERENCE_X264_1080P * 2, realtimeFps:null, estimated:true },
    tooHeavy:force ? {} : previous?.tooHeavy || {},
  };
  finalise(host);
  saveCache(host);
  current = host;
  const m = host.recommendations.music, p = host.recommendations.program;
  logger.log?.(`[hardware] ${host.hostType.label}, ${host.cores} cores (${host.cpuModel}); encoder ${host.encoder}; Chromium GPU ${host.chromiumGpu ? `yes (${chromium.renderer})` : `no${chromium.reason ? ` - ${chromium.reason}` : chromium.renderer ? ` (${chromium.renderer})` : ""}`}; x264 1080p ${(host.cpu.coreSecondsPerFrame * 1000).toFixed(1)} ms/frame`);
  logger.log?.(`[hardware] auto: Music 24/7 ${m.width}x${m.height}@${m.fps} ${m.mode} (~${m.cores} of ${m.budgetCores} budget cores); programs ${p.width}x${p.height}@${p.fps}`);
  return host;
}

// Kick off (or reuse) the probe. Safe to call from anywhere; resolves with
// the profile. Music 24/7 awaits this before its first start, so the stream
// is pushed at the tested quality from the first frame.
function ensureHostProfile(options = {}) {
  if (String(process.env.CASTNEXUS_HARDWARE_PROBE || "true").toLowerCase() === "false") {
    if (!current) { const { detectEncoder } = require("./gpu-encoder"); current = fallbackProfile(detectEncoder()); }
    return Promise.resolve(current);
  }
  if (!probing || options.force) {
    probing = runProbe(options).catch(error => {
      (options.logger || console).warn?.(`[hardware] probe failed: ${error.message}`);
      const { detectEncoder } = require("./gpu-encoder");
      return (current = fallbackProfile(detectEncoder()));
    });
  }
  return probing;
}

function getHostProfile() {
  if (current) return current;
  const { detectEncoder } = require("./gpu-encoder");
  const cached = loadCache(fingerprint(detectEncoder().id));
  current = cached ? finalise(cached) : fallbackProfile(detectEncoder());
  return current;
}

// Live feedback: a tier that cannot hold realtime is marked too heavy so the
// next start (and the recommendation) moves one tier down.
function markTooHeavy(kind, tierId, reason = "") {
  const host = getHostProfile();
  host.tooHeavy = host.tooHeavy || {};
  const list = new Set(host.tooHeavy[kind] || []);
  if (list.has(tierId)) return false;
  list.add(tierId);
  host.tooHeavy[kind] = [...list];
  finalise(host);
  if (host.probed) saveCache(host);
  console.warn(`[hardware] ${kind} tier ${tierId} could not keep up${reason ? ` (${reason})` : ""}; auto now uses ${host.recommendations[kind].id}`);
  return true;
}

// Real frame rate / size of an incoming stream (OBS, console, rerun), so an
// auto program never renders more frames than the source actually has.
function probeStreamInfo(url, { timeoutMs = 5000, ffprobe = process.env.FFPROBE_BIN || "ffprobe" } = {}) {
  return new Promise(resolve => {
    let out = "", child;
    try {
      child = spawn(ffprobe, ["-v", "error", "-rw_timeout", String(timeoutMs * 1000), "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate", "-of", "json", url], { stdio:["ignore", "pipe", "ignore"] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs + 500);
    child.stdout.on("data", d => { out += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const s = JSON.parse(out).streams?.[0];
        if (!s) return resolve(null);
        const rate = value => { const [n, d] = String(value || "0/1").split("/").map(Number); return d > 0 ? n / d : 0; };
        const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate);
        resolve({ width:Number(s.width) || null, height:Number(s.height) || null, fps:fps > 0 && fps < 241 ? Math.round(fps) : null });
      } catch { resolve(null); }
    });
  });
}

// Program settings to use for one orientation: fixed values from Overlay
// Studio, or (auto) the tested tier capped at the source's own frame rate.
function autoProgram(orientation, { sourceFps = null, host = getHostProfile() } = {}) {
  const tier = host.recommendations.program;
  let fps = tier.fps;
  if (sourceFps) fps = Math.min(fps, Math.max(20, sourceFps));
  else fps = Math.min(fps, 30); // unknown source: never double-render a 30 fps feed
  const vertical = orientation === "vertical";
  return { width:vertical ? tier.height : tier.width, height:vertical ? tier.width : tier.height, fps, tier:tier.id };
}

module.exports = {
  CACHE_FILE,
  probeStreamInfo,
  autoProgram,
  MUSIC_TIERS,
  PROGRAM_TIERS,
  DEFAULT_BUDGET,
  detectHostType,
  softwareRenderer,
  probeX264,
  probeChromiumGpu,
  estimateMusicCores,
  estimateProgramCores,
  budgetFor,
  finalise,
  fallbackProfile,
  ensureHostProfile,
  getHostProfile,
  markTooHeavy,
  _setCurrent:host => { current = host ? finalise(host) : null; probing = null; },
};
