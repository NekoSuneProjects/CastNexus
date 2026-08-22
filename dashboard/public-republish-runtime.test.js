"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isLegacyPublicRepublish, publicRepublishInputArgs, buildStablePublicRepublishArgs, publicRtspDestination } = require("./public-republish-runtime");

const source = "rtmp://127.0.0.1:1935/profile/radio/0123456789abcdef0123456789abcdef0123";
const dest = "rtmp://127.0.0.1:1935/public/music-ci";
const oldArgs = [
  "-hide_banner", "-loglevel", "warning",
  "-i", source,
  "-map", "0:v:0",
  "-map", "0:a:0?",
  "-c:v", "copy",
  "-c:a", "copy",
  "-f", "flv",
  dest,
];

test("recognises only CastNexus internal public republish", () => {
  assert.equal(isLegacyPublicRepublish("ffmpeg", oldArgs), true);
  assert.equal(isLegacyPublicRepublish("ffmpeg", [...oldArgs.slice(0,-1), "rtmp://youtube.example/live/key"]), false);
});

test("public republish input bypasses the long live-stream analyze window", () => {
  const input = publicRepublishInputArgs();
  assert.equal(input[input.indexOf("-analyzeduration") + 1], "0");
  assert.equal(input[input.indexOf("-probesize") + 1], "32768");
  assert.equal(input[input.indexOf("-rtmp_live") + 1], "live");
  assert.match(input[input.indexOf("-fflags") + 1], /nobuffer/);
  assert.match(input[input.indexOf("-fflags") + 1], /genpts/);
});

test("public republish exposes AAC to HLS and Opus to WebRTC on one RTSP path", () => {
  const args = buildStablePublicRepublishArgs(oldArgs);
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a:0") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a:1") + 1], "libopus");
  assert.equal(args.filter(value=>value==="0:a:0?").length,2);
  assert.ok(args.includes("-avoid_negative_ts"));
  assert.ok(args.includes("make_zero"));
  assert.equal(args[args.indexOf("-flush_packets") + 1], "1");
  assert.equal(args[args.indexOf("-rtsp_transport") + 1], "tcp");
  assert.equal(args[args.indexOf("-f") + 1], "rtsp");
  assert.equal(args[args.length - 1], "rtsp://127.0.0.1:8554/public/music-ci");
  assert.equal(publicRtspDestination(dest),"rtsp://127.0.0.1:8554/public/music-ci");
});
