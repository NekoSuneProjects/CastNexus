"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectFfmpeg } = require("./ffmpeg-selector");

test("keeps bundled FFmpeg when its NVENC probe succeeds", () => {
  const selected = selectFfmpeg({ bundled:"bundled", platform:"win32", probe:binary => ({ ok:binary === "bundled", error:"" }) });
  assert.deepEqual(selected, { binary:"bundled", source:"bundled", nvenc:true, encoder:"h264_nvenc", hardware:true });
});

test("uses system FFmpeg when bundled NVENC is newer than the installed driver", () => {
  const selected = selectFfmpeg({ bundled:"bundled", system:"ffmpeg", platform:"win32", probe:(binary, encoder) => binary === "ffmpeg" && encoder === "h264_nvenc" ? { ok:true } : { ok:false, error:"required NVENC API is newer" } });
  assert.equal(selected.binary, "ffmpeg");
  assert.equal(selected.source, "system");
  assert.equal(selected.nvenc, true);
  assert.match(selected.fallbackReason, /newer/);
});

test("retains bundled FFmpeg for CPU fallback when neither NVENC probe works", () => {
  const selected = selectFfmpeg({ bundled:"bundled", platform:"win32", probe:() => ({ ok:false, error:"unavailable" }) });
  assert.equal(selected.binary, "bundled");
  assert.equal(selected.nvenc, false);
  assert.equal(selected.hardware, false);
  assert.equal(selected.encoder, "libx264");
});

test("AMD / Intel GPU PCs keep the bundled build when it drives that GPU", () => {
  const amd = selectFfmpeg({ bundled:"bundled", platform:"win32", probe:(binary, encoder) => ({ ok:binary === "bundled" && encoder === "h264_amf", error:"no device" }) });
  assert.equal(amd.source, "bundled");
  assert.equal(amd.encoder, "h264_amf");
  assert.equal(amd.nvenc, false);
  const intel = selectFfmpeg({ bundled:"bundled", platform:"linux", probe:(binary, encoder) => ({ ok:encoder === "h264_qsv" }) });
  assert.equal(intel.encoder, "h264_qsv");
});
