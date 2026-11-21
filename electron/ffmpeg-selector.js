"use strict";

const { spawnSync } = require("node:child_process");

// Hardware H.264 encoders worth checking per OS, best first. The dashboard's
// gpu-encoder.js makes the final per-stream choice (and falls back to CPU
// x264); this only decides WHICH FFmpeg binary to hand it, so a GPU that the
// bundled build cannot drive (e.g. NVENC API newer than an old NVIDIA driver)
// is still used through a working system FFmpeg.
function hardwareEncoders(platform = process.platform) {
  if (platform === "win32") return ["h264_nvenc", "h264_qsv", "h264_amf"];
  if (platform === "darwin") return ["h264_videotoolbox"];
  return ["h264_nvenc", "h264_qsv"];
}

function encoderProbeArgs(encoder = "h264_nvenc") {
  return ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:r=1", "-frames:v", "1", "-an", "-c:v", encoder, "-f", "null", "-"];
}

// Kept for compatibility with older callers/tests.
function nvencProbeArgs() {
  return encoderProbeArgs("h264_nvenc");
}

function probeEncoder(binary, encoder = "h264_nvenc", spawn = spawnSync) {
  if (!binary) return { ok:false, error:"FFmpeg path is empty" };
  const result = spawn(binary, encoderProbeArgs(encoder), { encoding:"utf8", timeout:12_000, windowsHide:true });
  return { ok:result.status === 0, error:String(result.stderr || result.stdout || result.error?.message || `${encoder} probe failed`).trim().slice(-1000) };
}

function probeNvenc(binary, spawn = spawnSync) {
  return probeEncoder(binary, "h264_nvenc", spawn);
}

// First hardware encoder that really encodes a frame with this binary.
function firstWorking(binary, encoders, probe) {
  let firstError = "";
  for (const encoder of encoders) {
    const result = probe(binary, encoder);
    if (result.ok) return { encoder, error:"" };
    firstError = firstError || result.error || "";
  }
  return { encoder:null, error:firstError };
}

function selectFfmpeg({ bundled, system = "ffmpeg", probe = probeEncoder, platform = process.platform } = {}) {
  const encoders = hardwareEncoders(platform);
  const describe = (binary, source, encoder, fallbackReason) => ({
    binary, source, nvenc:encoder === "h264_nvenc", encoder:encoder || "libx264", hardware:!!encoder,
    ...(fallbackReason ? { fallbackReason } : {}),
  });
  if (!bundled) return describe(system, "system", firstWorking(system, encoders, probe).encoder);
  const fromBundled = firstWorking(bundled, encoders, probe);
  if (fromBundled.encoder) return describe(bundled, "bundled", fromBundled.encoder);
  const fromSystem = firstWorking(system, encoders, probe);
  if (fromSystem.encoder) return describe(system, "system", fromSystem.encoder, fromBundled.error);
  // No GPU encoder anywhere: keep the bundled build; CastNexus uses CPU x264
  // tuned to this PC's measured CPU speed.
  return describe(bundled, "bundled", null, fromBundled.error);
}

module.exports = { hardwareEncoders, encoderProbeArgs, nvencProbeArgs, probeEncoder, probeNvenc, selectFfmpeg };
