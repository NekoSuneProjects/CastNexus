"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { destinationFfmpegArgs } = require("./destination-output");

test("RTMP source-layout destinations copy video and normalise audio to AAC", () => {
  const args = destinationFfmpegArgs("rtmp://127.0.0.1:1935/live/abc", { url:"rtmp://example.com/app/key", layout:"source" }, { forceCpu:true });
  assert.ok(args.includes("copy"));
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("flv"));
  assert.equal(args.includes("whip"), false);
});

test("WHIP destinations always transcode (no source copy fast path) and use Opus audio", () => {
  const args = destinationFfmpegArgs("rtmp://127.0.0.1:1935/live/abc", { url:"https://relay.example.com/whip/node-1", layout:"source", transport:"whip" }, { forceCpu:true });
  assert.equal(args.includes("copy"), false);
  assert.ok(args.includes("libopus"));
  assert.ok(args.includes("whip"));
  assert.equal(args.includes("flv"), false);
});

test("WHIP destinations honour an explicit non-source layout", () => {
  const args = destinationFfmpegArgs("rtmp://127.0.0.1:1935/live/abc", { url:"https://relay.example.com/whip/node-1", layout:"vertical", transport:"whip" }, { forceCpu:true });
  assert.ok(args.includes("libopus"));
  assert.ok(args.includes("whip"));
});
