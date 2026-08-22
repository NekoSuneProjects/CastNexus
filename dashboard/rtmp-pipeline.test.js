"use strict";

const assert = require("node:assert/strict");
const { piSafeMode, safeCanvas, stableAudioArgs, liveMuxArgs, cpuX264Preset } = require("./rtmp-pipeline");
const { destinationFfmpegArgs } = require("./destination-output");

assert.equal(piSafeMode({ arch:"arm64", hardwareEncoder:false, setting:"auto" }), true);
assert.equal(piSafeMode({ arch:"arm64", hardwareEncoder:true, setting:"auto" }), false);
assert.equal(piSafeMode({ arch:"x64", hardwareEncoder:false, setting:"auto" }), true, "CPU-only VPS/x64 hosts need the same compositor protection as a Pi");
assert.equal(piSafeMode({ arch:"x64", hardwareEncoder:true, setting:"auto" }), false);
assert.equal(piSafeMode({ arch:"arm64", hardwareEncoder:false, setting:"false" }), false);

assert.deepEqual(
  safeCanvas("landscape", { arch:"arm64", hardwareEncoder:false, width:1920, height:1080, fps:30 }),
  { width:960, height:540, fps:20, screencastQuality:60 },
  "CPU-only Pi rendering must stay below the old 720p30 CDP/x264 pressure point"
);
assert.deepEqual(
  safeCanvas("landscape", { arch:"x64", hardwareEncoder:false, width:1920, height:1080, fps:30 }),
  { width:960, height:540, fps:20, screencastQuality:60 },
  "CPU-only VPS rendering must not attempt the observed 1080p30 software compositor workload"
);
assert.deepEqual(
  safeCanvas("vertical", { arch:"arm64", hardwareEncoder:false, width:1080, height:1920, fps:30 }),
  { width:540, height:960, fps:20, screencastQuality:60 }
);
assert.deepEqual(safeCanvas("landscape", { arch:"arm64", hardwareEncoder:true, width:1920, height:1080, fps:30 }), { width:1920, height:1080, fps:30 });
assert.equal(cpuX264Preset({ arch:"arm64", hardwareEncoder:false }), "ultrafast");
assert.equal(cpuX264Preset({ arch:"x64", hardwareEncoder:false }), "ultrafast");

const old = {
  width:process.env.CASTNEXUS_CPU_SAFE_WIDTH,
  height:process.env.CASTNEXUS_CPU_SAFE_HEIGHT,
  fps:process.env.CASTNEXUS_CPU_SAFE_FPS,
  quality:process.env.CASTNEXUS_CPU_JPEG_QUALITY,
};
process.env.CASTNEXUS_CPU_SAFE_WIDTH = "854";
process.env.CASTNEXUS_CPU_SAFE_HEIGHT = "480";
process.env.CASTNEXUS_CPU_SAFE_FPS = "15";
process.env.CASTNEXUS_CPU_JPEG_QUALITY = "52";
assert.deepEqual(
  safeCanvas("landscape", { arch:"x64", hardwareEncoder:false, width:1920, height:1080, fps:30 }),
  { width:854, height:480, fps:15, screencastQuality:52 },
  "CPU-safe renderer must be tunable without rebuilding CastNexus"
);
for (const [key, value] of [
  ["CASTNEXUS_CPU_SAFE_WIDTH", old.width],
  ["CASTNEXUS_CPU_SAFE_HEIGHT", old.height],
  ["CASTNEXUS_CPU_SAFE_FPS", old.fps],
  ["CASTNEXUS_CPU_JPEG_QUALITY", old.quality],
]) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const audio = stableAudioArgs();
assert.equal(audio[audio.indexOf("-b:a") + 1], "128k");
assert.equal(audio[audio.indexOf("-ar") + 1], "44100");
assert.ok(audio.includes("aresample=async=1:first_pts=0"));

const mux = liveMuxArgs("rtmp://example/live/key", "flv");
assert.ok(mux.includes("-rtmp_live"));
assert.ok(mux.includes("no_duration_filesize"));

const source = destinationFfmpegArgs("rtmp://source/live", { url:"rtmp://youtube.example/live/key", layout:"source" }, { forceCpu:true });
assert.equal(source[source.indexOf("-c:v") + 1], "copy", "CPU-friendly source mode should not re-encode video");
assert.equal(source[source.indexOf("-c:a") + 1], "aac", "source mode must normalize audio instead of copying broken/low-bitrate AAC");
assert.equal(source[source.indexOf("-b:a") + 1], "128k");
assert.equal(source[source.indexOf("-ar") + 1], "44100");
assert.ok(source.includes("+genpts+discardcorrupt"));

const twitchSource = destinationFfmpegArgs("rtmp://source/live", { url:"rtmps://ingest.global-contribute.live-video.net/app/key", layout:"source" });
assert.equal(twitchSource[twitchSource.indexOf("-c:a") + 1], "copy", "stable compositor AAC should stay timestamp-identical on Twitch");
assert.match(twitchSource[twitchSource.indexOf("-fflags") + 1], /nobuffer/);
assert.equal(twitchSource[twitchSource.indexOf("-flush_packets") + 1], "1");

const forcedLandscape = destinationFfmpegArgs(
  "rtmp://source/live",
  { url:"rtmp://youtube.example/live/key2", layout:"landscape" },
  { forceCpu:true }
);
const forcedFilter = forcedLandscape[forcedLandscape.indexOf("-filter_complex") + 1];
assert.match(forcedFilter, /pad=960:540/, "CPU-safe VPS output should use cheap letterbox/pillarbox padding");
assert.doesNotMatch(forcedFilter, /gblur=/, "CPU-safe VPS output must avoid the expensive Gaussian blur filter");
assert.equal(forcedLandscape[forcedLandscape.indexOf("-preset") + 1], "ultrafast");

console.log("CPU-safe RTMP pipeline tests passed");
