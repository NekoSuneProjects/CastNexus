"use strict";

// Music 24/7 performance profiles.
//
// Benchmarks (tools/music24-benchmark.js) showed the original Music 24/7 cost
// was dominated by Chromium, not by FFmpeg: the scene ran several 60 Hz CSS
// animations (spinning vinyl, sliding progress gradient) plus a 30 Hz canvas
// with shadowBlur + a CSS drop-shadow filter + a full-screen mix-blend layer.
// Each of those damages the page at the compositor's own 60 Hz, and every
// damaged frame is software-rasterised (SwiftShader on a VPS) and JPEG
// encoded for the CDP screencast, even though FFmpeg only uses 20-30 of them.
//
// These profiles separate three rates that used to be coupled:
//
//   outputFps    what FFmpeg encodes/publishes (viewers see this cadence)
//   renderFps    how many browser frames are captured and fed to FFmpeg; the
//                fps filter duplicates frames up to outputFps, which costs
//                almost nothing to encode because duplicates are P-skips
//   spectrumHz   how often the page redraws the spectrum/animations
//
// plus progressHz (progress bar) and the 1 Hz clock, which never ran faster.

const MODES = Object.freeze(["auto", "max", "balanced", "low", "ultra"]);
const MODE_LABELS = Object.freeze({
  auto:"Auto",
  max:"Maximum Quality",
  balanced:"Balanced",
  low:"Low CPU",
  ultra:"Ultra Low CPU",
});
const RENDER_FPS_CHOICES = Object.freeze([10, 15, 20, 24, 30, 60]);

const PRESETS = Object.freeze({
  // Everything on. Render at the output rate.
  max:{ renderFps:null, spectrumHz:30, progressHz:10, effects:"full", jpegQuality:80 },
  // Output stays 30 fps; the page redraws its spectrum ~24 Hz.
  balanced:{ renderFps:24, spectrumHz:24, progressHz:8, effects:"reduced", jpegQuality:70 },
  // Graphics at 20 fps, spectrum ~12 Hz, expensive effects removed.
  low:{ renderFps:20, spectrumHz:12, progressHz:4, effects:"reduced", jpegQuality:65 },
  // 10-15 fps graphics; audio is untouched (it never goes through the browser).
  ultra:{ renderFps:12, spectrumHz:10, progressHz:2, effects:"minimal", jpegQuality:60 },
});

function normaliseMode(value) {
  const v = String(value || "auto").trim().toLowerCase();
  if (v === "maximum" || v === "maximum-quality" || v === "quality") return "max";
  if (v === "low-cpu") return "low";
  if (v === "ultra-low" || v === "ultra-low-cpu") return "ultra";
  return MODES.includes(v) ? v : "auto";
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// Auto picks a profile from what the host can actually do: a working hardware
// encoder leaves the CPU for Chromium, so Balanced is affordable. Without one
// (typical small VPS), x264 AND software rasterisation share the CPU, so Low.
// Auto never chooses Maximum: Chromium's GPU path inside containers often
// falls back to SwiftShader silently, and full 60 Hz effects in software cost
// ~3-4 cores at 1080p (tools/music24-benchmark.js). Maximum is opt-in.
function autoMode({ hardwareEncoder = false } = {}) {
  return hardwareEncoder ? "balanced" : "low";
}

// Docker Compose forwards unset variables as "", which must mean "not set"
// (Number("") is 0 and would clamp the spectrum to 1 Hz).
function present(...values) {
  for (const v of values) if (v != null && v !== "") return v;
  return undefined;
}

function resolveMusicPerformance(settings = {}, { hardwareEncoder = false, chromiumGpu = false, outputFps = 30 } = {}) {
  const requested = normaliseMode(settings.mode);
  const effective = requested === "auto" ? autoMode({ hardwareEncoder, chromiumGpu }) : requested;
  const preset = PRESETS[effective];
  const fps = clampInt(outputFps, 1, 60, 30);
  // Explicit render FPS from the dashboard/env wins, but can never exceed the
  // output rate (frames above it would simply be discarded by FFmpeg).
  const explicitRender = present(settings.renderFps, process.env.MUSIC24_RENDER_FPS);
  const renderFps = Math.min(fps, clampInt(explicitRender || preset.renderFps || fps, 1, 60, fps));
  const spectrumHz = Math.min(renderFps, clampInt(present(settings.spectrumHz, process.env.MUSIC24_SPECTRUM_HZ, preset.spectrumHz), 1, 60, preset.spectrumHz));
  const progressHz = Math.min(spectrumHz, clampInt(present(settings.progressHz, preset.progressHz), 1, 30, preset.progressHz));
  return {
    requested,
    mode:effective,
    label:MODE_LABELS[effective],
    outputFps:fps,
    renderFps,
    spectrumHz,
    progressHz,
    clockHz:1,
    effects:preset.effects,
    jpegQuality:clampInt(present(settings.jpegQuality, process.env.MUSIC24_JPEG_QUALITY, preset.jpegQuality), 35, 95, preset.jpegQuality),
  };
}

// CDP Page.startScreencast everyNthFrame: Chromium's compositor ticks at up to
// 60 Hz; asking for every Nth frame stops it JPEG-encoding frames FFmpeg will
// never use. Frames are only produced on damage, so a static scene still costs
// nothing either way.
function everyNthFrameFor(renderFps, compositorHz = 60) {
  return Math.max(1, Math.floor(compositorHz / Math.max(1, Number(renderFps) || 30)));
}

// Query parameters understood by music-scene.js. Keeping this in one place
// lets music24.js, the Studio preview and tests agree on the page contract.
function sceneQueryFor(perf) {
  return {
    perf:perf.mode,
    spectrumHz:String(perf.spectrumHz),
    progressHz:String(perf.progressHz),
    effects:perf.effects,
  };
}

module.exports = {
  MODES,
  MODE_LABELS,
  RENDER_FPS_CHOICES,
  PRESETS,
  normaliseMode,
  autoMode,
  resolveMusicPerformance,
  everyNthFrameFor,
  sceneQueryFor,
};
