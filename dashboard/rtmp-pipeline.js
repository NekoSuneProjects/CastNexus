"use strict";

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

function cpuX264Preset({ arch = process.arch, hardwareEncoder = false, explicit = null } = {}) {
  if (explicit) return String(explicit);
  return piSafeMode({ arch, hardwareEncoder }) ? "ultrafast" : "veryfast";
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

function safeCanvas(layout, { arch = process.arch, hardwareEncoder = false, width = null, height = null, fps = 30 } = {}) {
  const vertical = layout === "vertical";
  const desired = {
    width: Number(width) || (vertical ? 1080 : 1920),
    height: Number(height) || (vertical ? 1920 : 1080),
    fps: Math.max(1, Number(fps) || 30),
  };
  if (!piSafeMode({ arch, hardwareEncoder })) return desired;

  // Browser screencast + software x264 can overload both small ARM boards and
  // CPU-only VPS instances. Clamp the render surface before Chromium starts so
  // the watchdog does not repeatedly kill the same 1080p30 workload.
  return safeRenderConfig(layout, desired);
}

function liveInputArgs({ lowLatency = false } = {}) {
  const args=["-thread_queue_size", String(process.env.RTMP_INPUT_QUEUE || 1024), "-fflags", lowLatency?"+genpts+discardcorrupt+nobuffer":"+genpts+discardcorrupt"];
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

function liveMuxArgs(url, format = null) {
  const value = String(url || "");
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
  safeRenderConfig,
  piSafeRenderConfig,
  safeCanvas,
  liveInputArgs,
  stableAudioArgs,
  liveMuxArgs,
};
