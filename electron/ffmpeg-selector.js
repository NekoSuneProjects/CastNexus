"use strict";

const { spawnSync } = require("node:child_process");

function nvencProbeArgs() {
  return ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=128x72:r=1", "-frames:v", "1", "-an", "-c:v", "h264_nvenc", "-f", "null", "-"];
}

function probeNvenc(binary, spawn = spawnSync) {
  if (!binary) return { ok:false, error:"FFmpeg path is empty" };
  const result = spawn(binary, nvencProbeArgs(), { encoding:"utf8", timeout:12_000, windowsHide:true });
  return { ok:result.status === 0, error:String(result.stderr || result.stdout || result.error?.message || "NVENC probe failed").trim().slice(-1000) };
}

function selectFfmpeg({ bundled, system = "ffmpeg", probe = probeNvenc } = {}) {
  if (!bundled) return { binary:system, source:"system", nvenc:probe(system).ok };
  const bundledProbe = probe(bundled);
  if (bundledProbe.ok) return { binary:bundled, source:"bundled", nvenc:true };
  const systemProbe = probe(system);
  if (systemProbe.ok) return { binary:system, source:"system", nvenc:true, fallbackReason:bundledProbe.error };
  return { binary:bundled, source:"bundled", nvenc:false, fallbackReason:bundledProbe.error };
}

module.exports = { nvencProbeArgs, probeNvenc, selectFfmpeg };
