"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectFfmpeg } = require("./ffmpeg-selector");

test("keeps bundled FFmpeg when its NVENC probe succeeds", () => {
  const selected = selectFfmpeg({ bundled:"bundled", probe:binary => ({ ok:binary === "bundled", error:"" }) });
  assert.deepEqual(selected, { binary:"bundled", source:"bundled", nvenc:true });
});

test("uses system FFmpeg when bundled NVENC is newer than the installed driver", () => {
  const selected = selectFfmpeg({ bundled:"bundled", system:"ffmpeg", probe:binary => binary === "ffmpeg" ? { ok:true } : { ok:false, error:"required NVENC API is newer" } });
  assert.equal(selected.binary, "ffmpeg");
  assert.equal(selected.source, "system");
  assert.equal(selected.nvenc, true);
  assert.match(selected.fallbackReason, /newer/);
});

test("retains bundled FFmpeg for CPU fallback when neither NVENC probe works", () => {
  const selected = selectFfmpeg({ bundled:"bundled", probe:() => ({ ok:false, error:"unavailable" }) });
  assert.equal(selected.binary, "bundled");
  assert.equal(selected.nvenc, false);
});
