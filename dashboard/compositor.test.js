"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildChromiumGpuArgs } = require("./compositor");

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
