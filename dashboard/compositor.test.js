"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildChromiumGpuArgs, audioTransportFor } = require("./compositor");

test("CPU-only Chromium keeps software rasterization available", () => {
  const args = buildChromiumGpuArgs(false);
  assert.ok(args.includes("--disable-gpu"));
  assert.equal(args.includes("--disable-software-rasterizer"), false);
});

test("GPU compositor keeps the accelerated flags", () => {
  const args = buildChromiumGpuArgs(true);
  assert.ok(args.includes("--enable-gpu-rasterization"));
  assert.ok(args.includes("--use-gl=egl"));
});

test("Windows audio uses loopback UDP instead of Unix FIFO files", () => {
  const transport = audioTransportFor("account-profile", "C:\\temp\\castnexus", "win32");
  assert.equal(transport.fifo, false);
  assert.match(transport.live.input, /^udp:\/\/127\.0\.0\.1:/);
  assert.match(transport.music.output, /pkt_size=3840/);
  assert.notEqual(transport.live.input, transport.music.input);
});

test("Linux and Docker audio retain named pipes", () => {
  const transport = audioTransportFor("account-profile", "/tmp/castnexus", "linux");
  assert.equal(transport.fifo, true);
  assert.match(transport.music.input.replaceAll("\\", "/"), /\/tmp\/castnexus\/music-audio\.fifo$/);
});
