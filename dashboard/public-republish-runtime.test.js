"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isLegacyPublicRepublish, publicRepublishInputArgs, buildStablePublicRepublishArgs } = require("./public-republish-runtime");

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

test("stable public republish keeps streams copied but starts/flushed as live RTMP", () => {
  const args = buildStablePublicRepublishArgs(oldArgs);
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.ok(args.includes("-avoid_negative_ts"));
  assert.ok(args.includes("make_zero"));
  assert.equal(args[args.indexOf("-flush_packets") + 1], "1");
  assert.ok(args.includes("-flvflags"));
  assert.ok(args.includes("no_duration_filesize"));
  const rtmpLiveIndexes = args.map((v,i) => v === "-rtmp_live" ? i : -1).filter(i => i >= 0);
  assert.ok(rtmpLiveIndexes.length >= 2, "RTMP live mode should apply to both the internal input and output");
  assert.equal(args[args.length - 1], dest);
});
