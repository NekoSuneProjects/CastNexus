"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "castnexus-hw-test-"));
process.env.CASTNEXUS_HOST_PROFILE_FILE = path.join(tmp, "host-profile.json");
process.env.CASTNEXUS_HARDWARE_PROBE = "false";
const hp = require("./hardware-profile");

const files = map => file => map[file] || "";

function host(overrides) {
  return hp.finalise({
    probed:true, hostType:{ type:"desktop" }, cores:8, hardwareEncoder:false, chromiumGpu:false,
    cpu:{ coreSecondsPerFrame:0.009 }, tooHeavy:{}, ...overrides,
  });
}

test("classifies Raspberry Pi, VPS and desktop hosts", () => {
  assert.equal(hp.detectHostType({ platform:"linux", arch:"arm64", files:files({ "/proc/device-tree/model":"Raspberry Pi 4 Model B Rev 1.4\0" }) }).type, "pi");
  assert.equal(hp.detectHostType({ platform:"linux", arch:"x64", files:files({ "/proc/cpuinfo":"flags\t\t: fpu vme hypervisor sse2", "/sys/class/dmi/id/sys_vendor":"QEMU" }) }).type, "vps");
  assert.match(hp.detectHostType({ platform:"linux", arch:"x64", files:files({ "/sys/class/dmi/id/sys_vendor":"Hetzner" }) }).label, /Hetzner/);
  assert.equal(hp.detectHostType({ platform:"linux", arch:"x64", files:files({ "/proc/cpuinfo":"flags : fpu sse2 avx2" }) }).type, "desktop");
  assert.equal(hp.detectHostType({ platform:"win32", arch:"x64", files:files({}) }).type, "desktop");
});

test("SwiftShader / llvmpipe count as software rendering", () => {
  assert.equal(hp.softwareRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)"), true);
  assert.equal(hp.softwareRenderer("llvmpipe (LLVM 15.0.6, 256 bits)"), true);
  assert.equal(hp.softwareRenderer("ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)"), false);
});

// 7.8 ms/frame = the i7-6700K + GTX 980 Ti desktop this was measured on.
test("a GPU PC streams Music 24/7 at 1080p30 and programs at 1080p60", () => {
  const h = host({ hardwareEncoder:true, chromiumGpu:true, cpu:{ coreSecondsPerFrame:0.0078 } });
  assert.equal(h.recommendations.music.id, "1080p30-balanced");
  assert.equal(h.recommendations.program.id, "1080p60");
});

test("a 6-core CPU-only VPS gets the best tier that stays inside half the machine", () => {
  const h = host({ hostType:{ type:"vps" }, cores:6, cpu:{ coreSecondsPerFrame:0.0144 } });
  const m = h.recommendations.music;
  assert.ok(m.cores <= 3, `music uses ${m.cores} of 3 budget cores`);
  assert.equal(m.width, 1920, "a 6-core VPS still manages 1080p with the optimised renderer");
  const p = h.recommendations.program;
  assert.ok(p.cores <= 3);
  assert.ok(p.fps <= 30, "no 60 fps gameplay render on a CPU-only VPS");
});

test("small VPSes and Pis step down resolution/FPS instead of overloading", () => {
  const tiny = host({ hostType:{ type:"vps" }, cores:2, cpu:{ coreSecondsPerFrame:0.0144 } });
  assert.ok(tiny.recommendations.music.width < 1920);
  const pi = host({ hostType:{ type:"pi" }, cores:4, cpu:{ coreSecondsPerFrame:0.054 } });
  assert.ok(pi.recommendations.music.cores <= pi.recommendations.music.budgetCores);
  assert.ok(pi.recommendations.program.width <= 1280);
});

test("Auto never picks Maximum (full 60 Hz effects)", () => {
  const h = host({ hardwareEncoder:true, chromiumGpu:true, cores:64 });
  assert.notEqual(h.recommendations.music.mode, "max");
});

test("a tier that could not keep up live is skipped next time", () => {
  hp._setCurrent(host({ hostType:{ type:"vps" }, cores:6, cpu:{ coreSecondsPerFrame:0.0144 } }));
  const first = hp.getHostProfile().recommendations.music.id;
  assert.equal(hp.markTooHeavy("music", first, "test"), true);
  const next = hp.getHostProfile().recommendations.music.id;
  assert.notEqual(next, first);
  assert.equal(hp.markTooHeavy("music", first), false, "only once");
  hp._setCurrent(null);
});

test("auto programs never render more frames than the source stream has", () => {
  const h = host({ hardwareEncoder:true, chromiumGpu:true, cpu:{ coreSecondsPerFrame:0.0078 } });
  assert.equal(hp.autoProgram("landscape", { sourceFps:30, host:h }).fps, 30);
  assert.equal(hp.autoProgram("landscape", { sourceFps:60, host:h }).fps, 60);
  assert.equal(hp.autoProgram("landscape", { sourceFps:null, host:h }).fps, 30, "unknown source: capped at 30");
  const v = hp.autoProgram("vertical", { sourceFps:60, host:h });
  assert.ok(v.height > v.width, "vertical programs are rotated, not stretched");
});

test("the budget honours CASTNEXUS_AUTO_CPU_BUDGET", () => {
  const h = host({ cores:8 });
  process.env.CASTNEXUS_AUTO_CPU_BUDGET = "0.25";
  try { assert.equal(hp.budgetFor(h).cores, 2); } finally { delete process.env.CASTNEXUS_AUTO_CPU_BUDGET; }
  assert.equal(hp.budgetFor({ ...h, hostType:{ type:"desktop" } }).share, 0.35);
});

test("Music 24/7 Auto uses the hardware tier; pinned settings are respected", () => {
  const music24 = require("./music24");
  hp._setCurrent(host({ hostType:{ type:"vps" }, cores:2, cpu:{ coreSecondsPerFrame:0.0144 } }));
  try {
    const auto = music24.profileVideo({ id:"r", canvasMode:"landscape", musicPerformance:{ mode:"auto" } });
    const tier = hp.getHostProfile().recommendations.music;
    assert.equal(auto.width, tier.width);
    assert.equal(auto.autoTier, tier.id);
    const vertical = music24.profileVideo({ id:"r", canvasMode:"vertical", musicPerformance:{ mode:"auto" } });
    assert.ok(vertical.height > vertical.width);
    const pinned = music24.profileVideo({ id:"r", canvasMode:"landscape", musicPerformance:{ mode:"low", width:1920, height:1080, fps:30 } });
    assert.equal(pinned.width, 1920);
    assert.equal(pinned.autoTier, null);
  } finally { hp._setCurrent(null); }
});

test.after(() => { try { fs.rmSync(tmp, { recursive:true, force:true }); } catch {} });
