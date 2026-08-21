"use strict";

const assert = require("node:assert/strict");
const { piSafeMode, safeCanvas, stableAudioArgs, liveMuxArgs, cpuX264Preset } = require("./rtmp-pipeline");
const { destinationFfmpegArgs } = require("./destination-output");

assert.equal(piSafeMode({ arch:"arm64", hardwareEncoder:false, setting:"auto" }), true);
assert.equal(piSafeMode({ arch:"arm64", hardwareEncoder:true, setting:"auto" }), false);
assert.equal(piSafeMode({ arch:"x64", hardwareEncoder:false, setting:"auto" }), false);
assert.equal(piSafeMode({ arch:"arm64", hardwareEncoder:false, setting:"false" }), false);

assert.deepEqual(safeCanvas("landscape", { arch:"arm64", hardwareEncoder:false, width:1920, height:1080, fps:30 }), { width:1280, height:720, fps:30 });
assert.deepEqual(safeCanvas("vertical", { arch:"arm64", hardwareEncoder:false, width:1080, height:1920, fps:30 }), { width:720, height:1280, fps:30 });
assert.deepEqual(safeCanvas("landscape", { arch:"arm64", hardwareEncoder:true, width:1920, height:1080, fps:30 }), { width:1920, height:1080, fps:30 });
assert.equal(cpuX264Preset({ arch:"arm64", hardwareEncoder:false }), "ultrafast");

const audio = stableAudioArgs();
assert.equal(audio[audio.indexOf("-b:a") + 1], "128k");
assert.equal(audio[audio.indexOf("-ar") + 1], "48000");
assert.ok(audio.includes("aresample=async=1:first_pts=0"));

const mux = liveMuxArgs("rtmp://example/live/key", "flv");
assert.ok(mux.includes("-rtmp_live"));
assert.ok(mux.includes("no_duration_filesize"));

const source = destinationFfmpegArgs("rtmp://source/live", { url:"rtmp://youtube.example/live/key", layout:"source" }, { forceCpu:true });
assert.equal(source[source.indexOf("-c:v") + 1], "copy", "Pi-friendly source mode should not re-encode video");
assert.equal(source[source.indexOf("-c:a") + 1], "aac", "source mode must normalize audio instead of copying broken/low-bitrate AAC");
assert.equal(source[source.indexOf("-b:a") + 1], "128k");
assert.ok(source.includes("+genpts+discardcorrupt"));

console.log("Pi-safe RTMP pipeline tests passed");
