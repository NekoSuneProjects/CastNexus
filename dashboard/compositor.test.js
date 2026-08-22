"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildChromiumGpuArgs, audioTransportFor, useElectronOffscreen, watchdogActivityAt, audioInputPlan, defaultVideoConfig, electronOffscreenWindowOptions } = require("./compositor");

test("Electron install uses its bundled Chromium offscreen renderer", () => {
  assert.equal(useElectronOffscreen("electron", { electron:"37.0.0" }), true);
  assert.equal(useElectronOffscreen("electron", {}), false);
  assert.equal(useElectronOffscreen("docker", { electron:"37.0.0" }), false);
});

test("Electron watchdog tracks paints even while FFmpeg drops backpressured frames", () => {
  assert.equal(watchdogActivityAt(true, 200, 100), 200);
  assert.equal(watchdogActivityAt(false, 200, 100), 100);
});

test("Music-only compositor uses one paced audio input without amix", () => {
  const plan=audioInputPlan(false,"live","music");
  assert.equal(plan.args.filter(value=>value==="-i").length,1);
  assert.equal(plan.args.at(-1),"music");
  assert.doesNotMatch(plan.filter,/amix/);
});

test("default intermediate JPEG quality matches the proven desktop capture setting", () => {
  assert.equal(defaultVideoConfig().screencastQuality,70);
});

test("Electron offscreen dimensions describe the content surface", () => {
  const options=electronOffscreenWindowOptions(1920,1080);
  assert.equal(options.width,1920);
  assert.equal(options.height,1080);
  assert.equal(options.useContentSize,true);
  assert.equal(options.webPreferences.offscreen,true);
});

test("CPU-only Chromium keeps software rasterization available", () => {
  const args = buildChromiumGpuArgs(false);
  assert.ok(args.includes("--disable-gpu"));
  assert.equal(args.includes("--disable-software-rasterizer"), false);
});

test("Linux GPU compositor keeps the accelerated EGL flags", () => {
  const args = buildChromiumGpuArgs(true, "linux");
  assert.ok(args.includes("--enable-gpu-rasterization"));
  assert.ok(args.includes("--use-gl=egl"));
});

test("Windows GPU compositor uses ANGLE with Direct3D 11", () => {
  const args = buildChromiumGpuArgs(true, "win32");
  assert.ok(args.includes("--enable-gpu-rasterization"));
  assert.ok(args.includes("--use-gl=angle"));
  assert.ok(args.includes("--use-angle=d3d11"));
  assert.equal(args.includes("--use-gl=egl"), false);
});

test("Windows audio uses independently paced loopback TCP carriers", () => {
  const transport = audioTransportFor("account-profile", "C:\\temp\\castnexus", "win32");
  assert.equal(transport.fifo, false);
  assert.equal(transport.paced, true);
  assert.match(transport.live.input, /^tcp:\/\/127\.0\.0\.1:/);
  assert.match(transport.music.output, /^tcp:\/\/127\.0\.0\.1:/);
  assert.notEqual(transport.live.input, transport.music.input);
  assert.notEqual(transport.music.inputPort, transport.music.outputPort);
});

test("Linux and Docker audio retain named pipes", () => {
  const transport = audioTransportFor("account-profile", "/tmp/castnexus", "linux");
  assert.equal(transport.fifo, true);
  assert.match(transport.music.input.replaceAll("\\", "/"), /\/tmp\/castnexus\/music-audio\.fifo$/);
});
