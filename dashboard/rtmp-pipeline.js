"use strict";

const { spawnSync } = require("node:child_process");

function isArmArch(arch = process.arch) {
  return arch === "arm64" || arch === "arm";
}

function envBool(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const normal = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normal)) return true;
  if (["0", "false", "no", "off"].includes(normal)) return false;
  return fallback;
}

function safeModeSetting() {
  if (process.env.CASTNEXUS_CPU_SAFE_MODE != null && process.env.CASTNEXUS_CPU_SAFE_MODE !== "") {
    return process.env.CASTNEXUS_CPU_SAFE_MODE;
  }
  return process.env.CASTNEXUS_PI_SAFE_MODE;
}

function piSafeMode({ arch = process.arch, hardwareEncoder = false, setting = safeModeSetting() } = {}) {
  const explicit = envBool(setting, null);
  if (explicit !== null) return explicit;

  // "auto" used to protect only ARM/Raspberry Pi. Real VPS logs showed the
  // same Chromium CDP JPEG + software x264 overload on an amd64 CPU-only host
  // (1920x1080@30 repeatedly stalled the frame pump). Safe mode is really a
  // software-render/encode protection, so auto now applies to every host that
  // has no working hardware encoder. GPU-backed hosts keep the requested size.
  return !hardwareEncoder;
}

function cpuX264Preset({ arch = process.arch, hardwareEncoder = false, explicit = null, width = null, height = null, fps = null, kind = "transcode", host = undefined } = {}) {
  if (explicit) return String(explicit);
  return cpuX264Tuning({ arch, hardwareEncoder, width, height, fps, kind, host }).preset;
}

// x264 preset + thread count for a CPU encode. With a measured host profile
// (hardware-profile.js) a strong CPU gets a better-quality preset and more
// threads; Pi / unmeasured / weak hosts keep ultrafast with 2 threads.
function cpuX264Tuning({ arch = process.arch, hardwareEncoder = false, width = null, height = null, fps = null, kind = "transcode", host = undefined } = {}) {
  const legacy = { preset:piSafeMode({ arch, hardwareEncoder }) ? "ultrafast" : "veryfast", threads:null, auto:false };
  if (hardwareEncoder || !width || !height) return legacy;
  try {
    const hardwareProfile = require("./hardware-profile");
    const tuned = hardwareProfile.x264Tuning({ width:Number(width), height:Number(height), fps:Number(fps) || 30, kind, ...(host ? { host } : {}) });
    return tuned ? { ...tuned, auto:true } : legacy;
  } catch {
    return legacy;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function safeRenderConfig(layout, desired) {
  const vertical = layout === "vertical";
  // Keep the original PI_* variables as backwards-compatible aliases. New
  // CPU_* names describe the actual behaviour on Pi, bare-metal x64 and VPS.
  const safeWidth = positiveInt(process.env.CASTNEXUS_CPU_SAFE_WIDTH || process.env.CASTNEXUS_PI_SAFE_WIDTH, 960);
  const safeHeight = positiveInt(process.env.CASTNEXUS_CPU_SAFE_HEIGHT || process.env.CASTNEXUS_PI_SAFE_HEIGHT, 540);
  const safeFps = positiveInt(process.env.CASTNEXUS_CPU_SAFE_FPS || process.env.CASTNEXUS_PI_SAFE_FPS, 20);
  const jpegQuality = Math.max(35, Math.min(80, positiveInt(process.env.CASTNEXUS_CPU_JPEG_QUALITY || process.env.CASTNEXUS_PI_JPEG_QUALITY, 60)));

  const targetWidth = vertical ? safeHeight : safeWidth;
  const targetHeight = vertical ? safeWidth : safeHeight;

  return {
    width: Math.min(desired.width, targetWidth),
    height: Math.min(desired.height, targetHeight),
    fps: Math.min(desired.fps, safeFps),
    screencastQuality: jpegQuality,
  };
}

function piSafeRenderConfig(layout, desired) {
  return safeRenderConfig(layout, desired);
}

function safeCanvas(layout, { arch = process.arch, hardwareEncoder = false, width = null, height = null, fps = 30, transcode = false, host = undefined } = {}) {
  const vertical = layout === "vertical";
  const desired = {
    width: Number(width) || (vertical ? 1080 : 1920),
    height: Number(height) || (vertical ? 1920 : 1080),
    fps: Math.max(1, Number(fps) || 30),
  };
  if (!piSafeMode({ arch, hardwareEncoder })) return desired;

  // A destination transcode on a measured CPU-only host: use the largest size
  // that CPU can really encode (a 16-core desktop is not a Pi). Explicit
  // CASTNEXUS_CPU_SAFE_* values still win.
  // Docker/.env ship the defaults (960/540/20) explicitly, so only a value
  // that differs from them counts as the user pinning the size.
  const custom = (names, fallback) => names.some(name => process.env[name] && Number(process.env[name]) !== fallback);
  const pinned = custom(["CASTNEXUS_CPU_SAFE_WIDTH", "CASTNEXUS_PI_SAFE_WIDTH"], 960)
    || custom(["CASTNEXUS_CPU_SAFE_HEIGHT", "CASTNEXUS_PI_SAFE_HEIGHT"], 540)
    || custom(["CASTNEXUS_CPU_SAFE_FPS", "CASTNEXUS_PI_SAFE_FPS"], 20);
  if (transcode && !pinned && !isArmArch(arch)) {
    try {
      const fit = require("./hardware-profile").cpuTranscodeCanvas(desired, host ? { host } : {});
      if (fit) return fit;
    } catch {}
  }

  // Browser screencast + software x264 can overload both small ARM boards and
  // CPU-only VPS instances. Clamp the render surface before Chromium starts so
  // the watchdog does not repeatedly kill the same 1080p30 workload.
  return safeRenderConfig(layout, desired);
}

// Newer FFmpeg master builds only know -thread_queue_size as an output
// (muxer) option; passing it before -i aborts with "cannot be applied to
// input url ... Error parsing options for input file". Probe the active
// binary once (FFMPEG_BIN can be swapped at runtime by ffmpeg-select.js) and
// drop the flag when the input form is unsupported.
const inputThreadQueueSupport = new Map();

function supportsInputThreadQueue(bin = process.env.FFMPEG_BIN || "ffmpeg", spawn = spawnSync) {
  const forced = envBool(process.env.FFMPEG_INPUT_THREAD_QUEUE);
  if (forced != null) return forced;
  if (inputThreadQueueSupport.has(bin)) return inputThreadQueueSupport.get(bin);
  let supported = true;
  try {
    const result = spawn(bin, ["-hide_banner", "-loglevel", "error", "-thread_queue_size", "8", "-f", "lavfi", "-i", "anullsrc", "-frames:a", "1", "-f", "null", "-"], { encoding:"utf8", timeout:10_000, windowsHide:true });
    const output = `${result.stderr || ""}
${result.stdout || ""}`;
    if (/cannot be applied to input|Unrecognized option 'thread_queue_size'|Error parsing options for input/i.test(output)) supported = false;
  } catch {}
  inputThreadQueueSupport.set(bin, supported);
  return supported;
}

function inputThreadQueueArgs(size = process.env.RTMP_INPUT_QUEUE || 1024) {
  return supportsInputThreadQueue() ? ["-thread_queue_size", String(size)] : [];
}

function liveInputArgs({ lowLatency = false } = {}) {
  const args=[...inputThreadQueueArgs(), "-fflags", lowLatency?"+genpts+discardcorrupt+nobuffer":"+genpts+discardcorrupt"];
  if(lowLatency)args.push("-probesize","32768","-analyzeduration","0","-rtmp_live","live");
  return args;
}

function stableAudioArgs({ bitrate = process.env.DESTINATION_AUDIO_BITRATE || "128k", sampleRate = process.env.DESTINATION_AUDIO_RATE || "44100" } = {}) {
  return [
    "-af", "aresample=async=1:first_pts=0",
    "-c:a", "aac",
    "-b:a", String(bitrate),
    "-ar", String(sampleRate),
    "-ac", "2",
  ];
}

function whipAudioArgs({ bitrate = process.env.DESTINATION_AUDIO_BITRATE || "128k", sampleRate = process.env.DESTINATION_AUDIO_RATE || "48000" } = {}) {
  // WebRTC/WHIP mandates Opus audio - AAC (used for every other destination)
  // is not a valid WHIP payload type.
  return [
    "-af", "aresample=async=1:first_pts=0",
    "-c:a", "libopus",
    "-b:a", String(bitrate),
    "-ar", String(sampleRate),
    "-ac", "2",
  ];
}

function liveMuxArgs(url, format = null) {
  const value = String(url || "");
  if (format === "whip") return ["-max_muxing_queue_size", "2048", "-f", "whip"];
  if (value.startsWith("srt://")) return ["-f", format || "mpegts"];
  return [
    "-max_muxing_queue_size", "2048",
    "-f", format || "flv",
    "-flvflags", "no_duration_filesize",
    "-rtmp_live", "live",
  ];
}

module.exports = {
  isArmArch,
  envBool,
  safeModeSetting,
  piSafeMode,
  cpuX264Preset,
  cpuX264Tuning,
  safeRenderConfig,
  piSafeRenderConfig,
  safeCanvas,
  supportsInputThreadQueue,
  inputThreadQueueArgs,
  liveInputArgs,
  whipAudioArgs,
  stableAudioArgs,
  liveMuxArgs,
};
