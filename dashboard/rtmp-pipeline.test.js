"use strict";

const assert = require("node:assert/strict");
// The legacy CPU-safe assertions below must not depend on this machine's saved
// hardware test; auto-tuning is covered with injected host profiles at the end.
process.env.CASTNEXUS_CPU_AUTO_TUNE = "false";
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

{
  // FFmpeg builds where -thread_queue_size is output-only must not get it as an input option.
  const { supportsInputThreadQueue } = require("./rtmp-pipeline");
  const saved = process.env.FFMPEG_INPUT_THREAD_QUEUE;
  delete process.env.FFMPEG_INPUT_THREAD_QUEUE;
  const outputOnly = () => ({ status:1, stderr:"Option thread_queue_size (set the maximum number of queued packets per stream on the muxer) cannot be applied to input url anullsrc -- you are trying to apply an input option to an output file or vice versa." });
  assert.equal(supportsInputThreadQueue("test-output-only-ffmpeg", outputOnly), false);
  assert.equal(supportsInputThreadQueue("test-input-ok-ffmpeg", () => ({ status:0, stderr:"" })), true);
  process.env.FFMPEG_INPUT_THREAD_QUEUE = "false";
  assert.equal(supportsInputThreadQueue("test-input-ok-ffmpeg"), false);
  if (saved == null) delete process.env.FFMPEG_INPUT_THREAD_QUEUE; else process.env.FFMPEG_INPUT_THREAD_QUEUE = saved;
}

{
  // CPU-only auto-tuning: scale x264 preset / threads / output size to the measured CPU.
  const { cpuX264Tuning, safeCanvas } = require("./rtmp-pipeline");
  delete process.env.CASTNEXUS_CPU_AUTO_TUNE;
  const host = (type, cores, ms, probed = true) => ({ probed, hostType:{ type }, cores, chromiumGpu:false, cpu:{ coreSecondsPerFrame:ms / 1000 }, tooHeavy:{} });
  const strong = host("desktop", 16, 5);
  const weakVps = host("vps", 2, 30);
  const pi = host("pi", 4, 60);
  const unprobed = host("desktop", 16, 5, false);

  const strongEnc = cpuX264Tuning({ width:1920, height:1080, fps:30, kind:"transcode", host:strong, arch:"x64" });
  assert.equal(strongEnc.preset, "faster", "16-core desktop should get a better-quality x264 preset");
  assert.ok(strongEnc.threads >= 2 && strongEnc.threads <= 8, `threads bounded (${strongEnc.threads})`);
  assert.equal(cpuX264Tuning({ width:1920, height:1080, fps:30, kind:"program", host:strong, arch:"x64" }).preset, "faster");

  const weakEnc = cpuX264Tuning({ width:1920, height:1080, fps:30, host:weakVps, arch:"x64" });
  assert.equal(weakEnc.preset, "ultrafast", "2-vCPU VPS stays on ultrafast");
  assert.equal(weakEnc.threads, 2);
  assert.equal(cpuX264Tuning({ width:1920, height:1080, fps:30, host:pi, arch:"arm64" }).preset, "ultrafast", "Pi keeps the safe path");
  assert.equal(cpuX264Tuning({ width:1920, height:1080, fps:30, host:unprobed, arch:"x64" }).auto, false, "unmeasured host keeps legacy defaults");
  assert.equal(cpuX264Tuning({ width:1920, height:1080, fps:30, host:strong, hardwareEncoder:true }).auto, false, "GPU encode is not x264-tuned");

  assert.deepEqual(safeCanvas("landscape", { arch:"x64", hardwareEncoder:false, width:1920, height:1080, fps:30, transcode:true, host:strong }), { width:1920, height:1080, fps:30 });
  assert.deepEqual(safeCanvas("vertical", { arch:"x64", hardwareEncoder:false, width:1080, height:1920, fps:30, transcode:true, host:strong }), { width:1080, height:1920, fps:30 });
  const weakCanvas = safeCanvas("landscape", { arch:"x64", hardwareEncoder:false, width:1920, height:1080, fps:30, transcode:true, host:host("vps", 2, 60) });
  assert.ok(weakCanvas.width <= 960 && weakCanvas.fps <= 30, `very weak VPS stays small (${JSON.stringify(weakCanvas)})`);
  assert.deepEqual(safeCanvas("landscape", { arch:"x64", hardwareEncoder:false, width:1920, height:1080, fps:30, transcode:true, host:unprobed }), safeCanvas("landscape", { arch:"x64", hardwareEncoder:false, width:1920, height:1080, fps:30 }), "unmeasured host keeps the CPU-safe clamp");
  process.env.CASTNEXUS_CPU_AUTO_TUNE = "false";
}

{
  const { vaapiDevices } = require("./gpu-encoder");
  const saved = process.env.VAAPI_DEVICE;
  delete process.env.VAAPI_DEVICE;
  assert.deepEqual(vaapiDevices({ readdir:() => ["card0", "renderD129", "renderD128", "card1"] }), ["/dev/dri/renderD128", "/dev/dri/renderD129"]);
  assert.deepEqual(vaapiDevices({ readdir:() => { throw new Error("no /dev/dri"); } }), ["/dev/dri/renderD128"]);
  process.env.VAAPI_DEVICE = "/dev/dri/renderD130";
  assert.deepEqual(vaapiDevices(), ["/dev/dri/renderD130"]);
  if (saved == null) delete process.env.VAAPI_DEVICE; else process.env.VAAPI_DEVICE = saved;
}
