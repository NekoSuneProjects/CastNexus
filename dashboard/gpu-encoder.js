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
    default: {
      // libx264 defaults to one thread per detected CPU core. On a weak or
      // shared host, several concurrent ffmpeg encodes (compositor, per-
      // destination transcodes) each grabbing every core causes exactly the
      // oversubscription/context-switch thrashing that starves everything.
      // A small fixed count keeps one encode's footprint bounded; override
      // with X264_THREADS on hosts that actually have cores to spare.
      const threads = Math.max(1, Number(process.env.X264_THREADS) || 2);
      return ["-c:v", "libx264", "-preset", process.env.X264_PRESET || options.x264Preset || "veryfast", "-tune", "zerolatency", "-threads", String(threads), ...commonRate, "-profile:v", "high", "-level:v", "4.2", "-pix_fmt", "yuv420p"];
    }
  }
}

// ---------------------------------------------------------------------------
// Per-component encoder preference + fallback chain.
//
// detectEncoder() is the install-wide choice (CASTNEXUS_VIDEO_ENCODER). Music
// 24/7 and individual destinations can additionally ask for a specific
// encoder from the dashboard. Every hardware choice is still probed with a
// real one-frame encode before use, and a runtime failure walks down the
// chain (e.g. NVENC -> Quick Sync/VAAPI -> x264) instead of stopping output.

const PREFERENCES = Object.freeze(["auto", "nvenc", "qsv", "vaapi", "amf", "videotoolbox", "cpu"]);
const PREFERENCE_LABELS = Object.freeze({ auto:"Auto", nvenc:"NVIDIA NVENC", qsv:"Intel Quick Sync", vaapi:"VAAPI", amf:"AMD AMF", videotoolbox:"Apple VideoToolbox", cpu:"CPU x264" });
const probeCache = new Map();
let advertisedCache = null;

function normalisePreference(value) {
  const v = String(value || "auto").trim().toLowerCase();
  if (["cpu", "x264", "libx264", "software"].includes(v)) return "cpu";
  if (["quicksync", "quick-sync", "intel", "h264_qsv"].includes(v)) return "qsv";
  if (["nvidia", "h264_nvenc"].includes(v)) return "nvenc";
  if (v === "h264_vaapi") return "vaapi";
  if (["amd", "h264_amf"].includes(v)) return "amf";
  return PREFERENCES.includes(v) ? v : "auto";
}

function advertisedSet(advertisedText = null) {
  if (advertisedText != null) return advertisedEncoders(advertisedText);
  if (!advertisedCache) advertisedCache = advertisedEncoders(encoderOutput());
  return advertisedCache;
}

function probeOnce(profile, probe = probeProfile) {
  if (probe !== probeProfile) return probe(profile);
  const hit = probeCache.get(profile.id);
  if (hit) return hit;
  const result = probe(profile);
  probeCache.set(profile.id, result);
  return result;
}

// Ordered candidates for a preference: the preferred encoder first, then the
// remaining hardware encoders in the platform's normal order, then x264.
function fallbackOrder(preference = "auto", { platform = process.platform, advertisedText = null } = {}) {
  const pref = normalisePreference(preference);
  if (pref === "cpu") return [CPU_PROFILE];
  const advertised = advertisedSet(advertisedText);
  const hardware = reorderCandidates(candidateProfiles(platform)).filter(p => advertised.has(p.encoder));
  const preferred = hardware.filter(p => p.id === pref);
  const rest = hardware.filter(p => p.id !== pref);
  return [...preferred, ...rest, CPU_PROFILE];
}

// Next working encoder after the given one failed at runtime. Probes lazily and
// caches probe results so repeated fallbacks do not re-spawn FFmpeg.
function nextWorkingEncoder(preference, failedIds = [], { probe = probeProfile, advertisedText = null } = {}) {
  const failed = new Set((failedIds || []).map(String));
  const reason = failed.size ? `fell back after ${[...failed].join(", ")} failed` : undefined;
  for (const candidate of fallbackOrder(preference, { advertisedText })) {
    if (failed.has(candidate.id)) continue;
    if (!candidate.hardware) return { ...CPU_PROFILE, requested:normalisePreference(preference), ...(reason ? { fallbackReason:reason } : {}) };
    const result = probeOnce(candidate, probe);
    if (result.ok) return { ...candidate, requested:normalisePreference(preference), ...(reason ? { fallbackReason:reason } : {}) };
  }
  return { ...CPU_PROFILE, requested:normalisePreference(preference) };
}

function resolveEncoder(preference = "auto", options = {}) {
  const pref = normalisePreference(preference);
  if (pref === "auto") return detectEncoder(options.advertisedText != null || options.probe ? { force:true, advertisedText:options.advertisedText, probe:options.probe || probeProfile } : {});
  if (pref === "cpu") return { ...CPU_PROFILE, requested:"cpu" };
  const chosen = nextWorkingEncoder(pref, [], options);
  if (chosen.id !== pref) return { ...chosen, fallbackReason:chosen.fallbackReason || `${PREFERENCE_LABELS[pref] || pref} is not available on this host` };
  return chosen;
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
  PREFERENCES,
  PREFERENCE_LABELS,
  normalisePreference,
  fallbackOrder,
  nextWorkingEncoder,
  resolveEncoder,
};
