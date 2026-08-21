"use strict";

const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
let cached = null;

const CPU_PROFILE = Object.freeze({
  id: "libx264",
  encoder: "libx264",
  label: "CPU · x264",
  vendor: "cpu",
  hardware: false,
  device: null,
});

function encoderOutput() {
  const r = spawnSync(FFMPEG_BIN, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 10_000 });
  return `${r.stdout || ""}\n${r.stderr || ""}`;
}

function advertisedEncoders(text = encoderOutput()) {
  const found = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*[A-Z\.]{6}\s+([a-zA-Z0-9_]+)/);
    if (m) found.add(m[1]);
  }
  return found;
}

function candidateProfiles(platform = process.platform) {
  const common = [
    { id:"nvenc", encoder:"h264_nvenc", label:"NVIDIA NVENC", vendor:"nvidia", hardware:true },
    { id:"qsv", encoder:"h264_qsv", label:"Intel Quick Sync", vendor:"intel", hardware:true },
  ];
  if (platform === "win32") return [...common, { id:"amf", encoder:"h264_amf", label:"AMD AMF", vendor:"amd", hardware:true }];
  if (platform === "darwin") return [{ id:"videotoolbox", encoder:"h264_videotoolbox", label:"Apple VideoToolbox", vendor:"apple", hardware:true }];
  return [
    ...common,
    { id:"vaapi", encoder:"h264_vaapi", label:"VAAPI", vendor:"linux-gpu", hardware:true, device: process.env.VAAPI_DEVICE || "/dev/dri/renderD128" },
    { id:"v4l2m2m", encoder:"h264_v4l2m2m", label:"V4L2 M2M", vendor:"linux-soc", hardware:true },
  ];
}

function nvidiaPresent() {
  const r = spawnSync(process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi", ["-L"], { encoding:"utf8", timeout: 3000 });
  return r.status === 0;
}

function reorderCandidates(candidates) {
  if (!nvidiaPresent()) return candidates;
  return [...candidates].sort((a,b) => (a.vendor === "nvidia" ? -1 : b.vendor === "nvidia" ? 1 : 0));
}

function probeArgs(profile) {
  const base = ["-hide_banner", "-loglevel", "error"];
  if (profile.id === "vaapi") {
    return [...base, "-vaapi_device", profile.device, "-f", "lavfi", "-i", "color=c=black:s=128x72:r=1", "-vf", "format=nv12,hwupload", "-frames:v", "1", "-an", "-c:v", profile.encoder, "-f", "null", "-"];
  }
  return [...base, "-f", "lavfi", "-i", "color=c=black:s=128x72:r=1", "-frames:v", "1", "-an", "-c:v", profile.encoder, "-f", "null", "-"];
}

function probeProfile(profile) {
  if (profile.id === "vaapi" && !fs.existsSync(profile.device)) return { ok:false, error:`${profile.device} not found` };
  const r = spawnSync(FFMPEG_BIN, probeArgs(profile), { encoding:"utf8", timeout: 12_000 });
  return { ok: r.status === 0, error: r.status === 0 ? null : String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(-1000) };
}

function explicitProfile(value, advertised) {
  const v = String(value || "").trim().toLowerCase();
  if (!v || v === "auto") return null;
  if (["cpu", "x264", "libx264", "software"].includes(v)) return CPU_PROFILE;
  const all = candidateProfiles();
  const byId = all.find(p => p.id === v || p.encoder.toLowerCase() === v);
  if (byId && advertised.has(byId.encoder)) return byId;
  return { ...CPU_PROFILE, requested: value, fallbackReason: `requested encoder ${value} is not available in this FFmpeg build` };
}

function detectEncoder({ force = false, advertisedText = null, probe = probeProfile } = {}) {
  if (cached && !force && advertisedText == null && probe === probeProfile) return cached;
  const advertised = advertisedEncoders(advertisedText == null ? encoderOutput() : advertisedText);
  const requested = process.env.CASTNEXUS_VIDEO_ENCODER || process.env.VIDEO_ENCODER || "auto";
  const explicit = explicitProfile(requested, advertised);
  if (explicit) {
    if (!explicit.hardware) return (cached = { ...explicit, requested, detectedAt:new Date().toISOString() });
    const result = probe(explicit);
    if (result.ok) return (cached = { ...explicit, requested, detectedAt:new Date().toISOString() });
    return (cached = { ...CPU_PROFILE, requested, fallbackReason: result.error || `${explicit.label} probe failed`, detectedAt:new Date().toISOString() });
  }

  for (const profile of reorderCandidates(candidateProfiles())) {
    if (!advertised.has(profile.encoder)) continue;
    const result = probe(profile);
    if (result.ok) return (cached = { ...profile, requested:"auto", detectedAt:new Date().toISOString() });
  }
  return (cached = { ...CPU_PROFILE, requested:"auto", detectedAt:new Date().toISOString() });
}

function globalEncoderArgs(profile = detectEncoder()) {
  if (profile.id === "vaapi") return ["-vaapi_device", profile.device || "/dev/dri/renderD128"];
  return [];
}

function encoderFilterSuffix(profile = detectEncoder(), inputLabel = "vbase", outputLabel = "v") {
  if (profile.id === "vaapi") return `[${inputLabel}]format=nv12,hwupload[${outputLabel}]`;
  return `[${inputLabel}]format=yuv420p[${outputLabel}]`;
}

function videoEncoderArgs(profile = detectEncoder(), options = {}) {
  const bitrate = String(options.bitrate || "6000k");
  const maxrate = String(options.maxrate || "6500k");
  const bufsize = String(options.bufsize || "12000k");
  const fps = Math.max(1, Number(options.fps || 30));
  const gop = String(Math.max(1, Number(options.gop || fps * 2)));

  const commonRate = ["-b:v", bitrate, "-maxrate", maxrate, "-bufsize", bufsize, "-g", gop];
  switch (profile.id) {
    case "nvenc":
      return ["-c:v", "h264_nvenc", "-preset", process.env.NVENC_PRESET || "p4", "-tune", "ll", "-rc", "cbr", ...commonRate, "-profile:v", "high", "-pix_fmt", "yuv420p"];
    case "qsv":
      return ["-c:v", "h264_qsv", "-preset", process.env.QSV_PRESET || "veryfast", ...commonRate, "-profile:v", "high", "-pix_fmt", "nv12"];
    case "vaapi":
      return ["-c:v", "h264_vaapi", ...commonRate, "-profile:v", "high"];
    case "amf":
      return ["-c:v", "h264_amf", "-usage", "lowlatency", "-quality", process.env.AMF_QUALITY || "speed", "-rc", "cbr", ...commonRate, "-profile:v", "high"];
    case "videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-realtime", "1", ...commonRate, "-profile:v", "high", "-pix_fmt", "yuv420p"];
    case "v4l2m2m":
      return ["-c:v", "h264_v4l2m2m", ...commonRate, "-pix_fmt", "yuv420p"];
    default:
      return ["-c:v", "libx264", "-preset", process.env.X264_PRESET || options.x264Preset || "veryfast", "-tune", "zerolatency", ...commonRate, "-profile:v", "high", "-level:v", "4.2", "-pix_fmt", "yuv420p"];
  }
}

function status() {
  const selected = detectEncoder();
  return {
    selected,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    ffmpeg: FFMPEG_BIN,
    fallback: !selected.hardware,
  };
}

module.exports = {
  CPU_PROFILE,
  advertisedEncoders,
  candidateProfiles,
  probeArgs,
  probeProfile,
  detectEncoder,
  globalEncoderArgs,
  encoderFilterSuffix,
  videoEncoderArgs,
  status,
};
