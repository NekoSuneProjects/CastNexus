"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "castnexus-music24-ready-"));
const fakeProbe = path.join(temp, "ffprobe");
fs.writeFileSync(fakeProbe, "#!/bin/sh\necho video\nexit 0\n", { mode:0o755 });

process.env.FFPROBE_BIN = fakeProbe;
process.env.MEDIAMTX_API = "http://127.0.0.1:1";
process.env.MUSIC24_API_PROBE_TIMEOUT_MS = "50";
process.env.MUSIC24_RTMP_PROBE_TIMEOUT_MS = "250";

const music24 = require("./music24");

test("direct RTMP probe succeeds when ffprobe sees media", async () => {
  assert.equal(await music24.probeRtmpPath("profile/radio/example"), true);
});

test("MediaMTX readiness falls back to RTMP probe when Control API is unavailable", async () => {
  assert.equal(await music24.mediaPathReady("profile/radio/example"), true);
});

test.after(() => {
  try { fs.rmSync(temp, { recursive:true, force:true }); } catch {}
});
