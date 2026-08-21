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

function piSafeMode({ arch = process.arch, hardwareEncoder = false, setting = process.env.CASTNEXUS_PI_SAFE_MODE } = {}) {
  const explicit = envBool(setting, null);
  if (explicit !== null) return explicit;
  return isArmArch(arch) && !hardwareEncoder;
}

function cpuX264Preset({ arch = process.arch, hardwareEncoder = false, explicit = null } = {}) {
  if (explicit) return String(explicit);
  return piSafeMode({ arch, hardwareEncoder }) ? "ultrafast" : "veryfast";
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function piSafeRenderConfig(layout, desired) {
  const vertical = layout === "vertical";
  const safeWidth = positiveInt(process.env.CASTNEXUS_PI_SAFE_WIDTH, 960);
  const safeHeight = positiveInt(process.env.CASTNEXUS_PI_SAFE_HEIGHT, 540);
  const safeFps = positiveInt(process.env.CASTNEXUS_PI_SAFE_FPS, 20);
  const jpegQuality = Math.max(35, Math.min(80, positiveInt(process.env.CASTNEXUS_PI_JPEG_QUALITY, 60)));

  const targetWidth = vertical ? safeHeight : safeWidth;
  const targetHeight = vertical ? safeWidth : safeHeight;

  return {
    width: Math.min(desired.width, targetWidth),
    height: Math.min(desired.height, targetHeight),
    fps: Math.min(desired.fps, safeFps),
    screencastQuality: jpegQuality,
  };
}

function safeCanvas(layout, { arch = process.arch, hardwareEncoder = false, width = null, height = null, fps = 30 } = {}) {
  const vertical = layout === "vertical";
  const desired = {
    width: Number(width) || (vertical ? 1080 : 1920),
    height: Number(height) || (vertical ? 1920 : 1080),
    fps: Math.max(1, Number(fps) || 30),
  };
  if (!piSafeMode({ arch, hardwareEncoder })) return desired;

  // CDP JPEG capture + software Chromium + x264 at 720p30 is too expensive on
  // CPU-only Raspberry Pi hosts. The old 1280x720@30 safe mode still allowed
  // FFmpeg's image2pipe queue to back up until the compositor watchdog killed
  // the radio stream. Use a lower browser/render surface and frame rate on ARM
  // software encode; users can override the values with CASTNEXUS_PI_SAFE_*.
  return piSafeRenderConfig(layout, desired);
}

function liveInputArgs() {
  return ["-thread_queue_size", String(process.env.RTMP_INPUT_QUEUE || 1024), "-fflags", "+genpts+discardcorrupt"];
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
  piSafeMode,
  cpuX264Preset,
  piSafeRenderConfig,
  safeCanvas,
  liveInputArgs,
  stableAudioArgs,
  liveMuxArgs,
};
