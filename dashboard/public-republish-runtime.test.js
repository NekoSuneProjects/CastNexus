"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isLegacyPublicRepublish, buildStablePublicRepublishArgs } = require("./public-republish-runtime");

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

test("stable public republish keeps video/audio copy but adds live RTMP timestamp/mux safety", () => {
  const args = buildStablePublicRepublishArgs(oldArgs);
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.ok(args.includes("+genpts+discardcorrupt"));
  assert.ok(args.includes("-avoid_negative_ts"));
  assert.ok(args.includes("make_zero"));
  assert.ok(args.includes("-flvflags"));
  assert.ok(args.includes("no_duration_filesize"));
  assert.ok(args.includes("-rtmp_live"));
  assert.equal(args[args.length - 1], dest);
});
