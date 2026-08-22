"use strict";

const { detectEncoder, globalEncoderArgs, encoderFilterSuffix, videoEncoderArgs } = require("./gpu-encoder");
const { cpuX264Preset, liveInputArgs, liveMuxArgs, piSafeMode, safeCanvas, stableAudioArgs } = require("./rtmp-pipeline");

const OUTPUT_LAYOUTS = ["source", "landscape", "vertical"];

function normaliseLayout(value) {
  return OUTPUT_LAYOUTS.includes(value) ? value : "source";
}

function outputFormatFor(url) {
  return String(url || "").startsWith("srt://") ? "mpegts" : "flv";
}

function isTwitchIngest(url){
  try{return new URL(String(url||"")).hostname.toLowerCase().endsWith("live-video.net");}catch{return false;}
}

function destinationFfmpegArgs(sourceUrl, destination, options = {}) {
  const layout = normaliseLayout(destination.layout);
  const twitchSource=layout === "source"&&isTwitchIngest(destination.url);
  const profile = options.forceCpu ? { id:"libx264", encoder:"libx264", hardware:false, label:"CPU · x264" } : detectEncoder();
  const input = ["-hide_banner", "-loglevel", "warning", ...liveInputArgs({lowLatency:twitchSource}), ...(layout === "source" ? [] : globalEncoderArgs(profile)), "-i", sourceUrl];
  const mux = [...liveMuxArgs(destination.url, outputFormatFor(destination.url)), destination.url];

  // Source/passthrough keeps video copy-light for Raspberry Pi and other small
  // hosts, but always normalises audio to a real AAC 128 kbps stereo stream.
  // Copying source AAC was the cause of YouTube seeing 0-2 kbps audio on some
  // relays, especially around silence and reconnects.
  if (layout === "source") {
    return [
      ...input,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "copy",
      ...(twitchSource?["-c:a","copy","-flush_packets","1"]:stableAudioArgs()),
      ...mux,
    ];
  }

  const requestedFps = Number(process.env.DESTINATION_FPS || 30);
  const canvas = safeCanvas(layout, { hardwareEncoder:profile.hardware, fps:requestedFps });
  const width = canvas.width;
  const height = canvas.height;
  const fps = String(canvas.fps);
  const cpuSafe = !profile.hardware && piSafeMode({ hardwareEncoder:false });
  const lowResolution = width <= 1280 && height <= 1280;
  const bitrate = process.env.DESTINATION_VIDEO_BITRATE || (lowResolution ? "4000k" : "6000k");
  const maxrate = process.env.DESTINATION_VIDEO_MAXRATE || bitrate;
  const bufsize = process.env.DESTINATION_VIDEO_BUFSIZE || (lowResolution ? "8000k" : "12000k");

  // The pretty blurred-fill layout is expensive in software because it scales,
  // crops, Gaussian-blurs and overlays every frame before x264. On CPU-only Pi
  // and VPS deployments this can be the difference between realtime and a
  // steadily growing RTMP buffer. Use one scale + pad pass in safe mode; retain
  // the blurred fill when a working hardware encoder is available (or safe mode
  // was explicitly disabled).
  const filter = cpuSafe
    ? [
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[vbase]`,
        encoderFilterSuffix(profile, "vbase", "v"),
      ].join(";")
    : [
        "[0:v]split=2[bg0][fg0]",
        `[bg0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28[bg]`,
        `[fg0]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg]`,
        "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[vbase]",
        encoderFilterSuffix(profile, "vbase", "v"),
      ].join(";");

  return [
    ...input,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "0:a:0?",
    "-r", fps,
    "-fps_mode", "cfr",
    ...videoEncoderArgs(profile, {
      fps:Number(fps),
      bitrate,
      maxrate,
      bufsize,
      x264Preset:process.env.DESTINATION_X264_PRESET || cpuX264Preset({ hardwareEncoder:profile.hardware }),
    }),
    ...stableAudioArgs(),
    ...mux,
  ];
}

module.exports = { OUTPUT_LAYOUTS, normaliseLayout, outputFormatFor, isTwitchIngest, destinationFfmpegArgs };
