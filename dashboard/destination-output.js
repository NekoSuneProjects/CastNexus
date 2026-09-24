"use strict";

const { detectEncoder, globalEncoderArgs, encoderFilterSuffix, videoEncoderArgs } = require("./gpu-encoder");
const { cpuX264Preset, liveInputArgs, liveMuxArgs, piSafeMode, safeCanvas, stableAudioArgs, whipAudioArgs } = require("./rtmp-pipeline");

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
  const whip = destination.transport === "whip";
  // WHIP/WebRTC has no passthrough-copy fast path here (it requires Opus
  // audio and a browser-compatible H264/VP8 profile the source rarely
  // already matches), so a "source" layout push is treated as "landscape"
  // once transcoding either way.
  const layout = whip && destination.layout === "source" ? "landscape" : normaliseLayout(destination.layout);
  const twitchSource=!whip&&layout === "source"&&isTwitchIngest(destination.url);
  const profile = options.forceCpu ? { id:"libx264", encoder:"libx264", hardware:false, label:"CPU · x264" } : detectEncoder();
  const input = ["-hide_banner", "-loglevel", "warning", ...liveInputArgs({lowLatency:twitchSource}), ...(layout === "source" ? [] : globalEncoderArgs(profile)), "-i", sourceUrl];
  const mux = [...liveMuxArgs(destination.url, whip ? "whip" : outputFormatFor(destination.url)), destination.url];

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
    ...(whip ? whipAudioArgs() : stableAudioArgs()),
    ...mux,
  ];
}

// ---------------------------------------------------------------------------
// Per-destination output layout (Overlay Studio routing).
//
// dest.output = {
//   mode:         "source" | "landscape" | "vertical" | "custom"
//   sceneId:      null (follow the live scene for that orientation) | scene id
//   width/height: null = match the program feed
//   fps:          null = match the program feed
//   videoEncoder: "auto" | "nvenc" | "qsv" | "vaapi" | "amf" | "cpu"
//   videoBitrateKbps: null = match the program feed
//   audioBitrateKbps, audioRate
//   captionMode:  "off" | "passthrough" | "server" | "burnin"
//   framing:      { fit, scale, offsetX, offsetY, crop } for raw vertical /
//                 custom conversions when the browser compositor is off
// }
//
// Destinations created before this existed only have `layout`; they keep
// their exact previous FFmpeg behaviour (see planDestination legacy branch).

const { captionPlan, normaliseCaptionMode } = require("./captions");
const { normalisePreference } = require("./gpu-encoder");

const OUTPUT_MODES = ["source", "landscape", "vertical", "custom"];
const FRAMING_FITS = ["fit", "fill", "crop", "stretch"];

function numOr(value, fallback, min, max) {
  if (value == null || value === "" || value === "program") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function even(n) {
  return n == null ? null : Math.max(2, Math.round(n) - (Math.round(n) % 2));
}

function sanitiseFraming(raw = {}) {
  const f = raw && typeof raw === "object" ? raw : {};
  const crop = f.crop && typeof f.crop === "object" ? f.crop : {};
  return {
    fit:FRAMING_FITS.includes(f.fit) ? f.fit : "fill",
    scale:numOr(f.scale, 1, 0.1, 8),
    offsetX:numOr(f.offsetX, 0, -2, 2),
    offsetY:numOr(f.offsetY, 0, -2, 2),
    crop:{ left:numOr(crop.left, 0, 0, 0.9), right:numOr(crop.right, 0, 0, 0.9), top:numOr(crop.top, 0, 0, 0.9), bottom:numOr(crop.bottom, 0, 0, 0.9) },
  };
}

function sanitiseOutput(raw = {}) {
  const o = raw && typeof raw === "object" ? raw : {};
  const mode = OUTPUT_MODES.includes(o.mode) ? o.mode : "landscape";
  let width = even(numOr(o.width, null, 128, 3840));
  let height = even(numOr(o.height, null, 128, 3840));
  if (mode === "custom" && (!width || !height)) { width = width || 1280; height = height || 720; }
  if (mode === "landscape" && width && height && height > width) [width, height] = [height, width];
  if (mode === "vertical" && width && height && width > height) [width, height] = [height, width];
  const audioRate = [44100, 48000].includes(Number(o.audioRate)) ? Number(o.audioRate) : null;
  return {
    mode,
    sceneId:/^[A-Za-z0-9_-]{1,64}$/.test(String(o.sceneId || "")) ? String(o.sceneId) : null,
    width:mode === "source" ? null : width,
    height:mode === "source" ? null : height,
    fps:mode === "source" ? null : (numOr(o.fps, null, 1, 60) == null ? null : Math.round(numOr(o.fps, null, 1, 60))),
    videoEncoder:normalisePreference(o.videoEncoder),
    videoBitrateKbps:mode === "source" ? null : (numOr(o.videoBitrateKbps, null, 300, 50000) == null ? null : Math.round(numOr(o.videoBitrateKbps, null, 300, 50000))),
    audioBitrateKbps:numOr(o.audioBitrateKbps, null, 32, 512) == null ? null : Math.round(numOr(o.audioBitrateKbps, null, 32, 512)),
    audioRate,
    captionMode:normaliseCaptionMode(o.captionMode),
    framing:sanitiseFraming(o.framing),
  };
}

// The editor's view of a legacy destination, used to pre-fill the form.
function outputFromLegacyLayout(layout) {
  const l = normaliseLayout(layout);
  if (l === "source") return sanitiseOutput({ mode:"landscape" });
  if (l === "landscape") return sanitiseOutput({ mode:"landscape", width:1920, height:1080 });
  return sanitiseOutput({ mode:"vertical", width:1080, height:1920, framing:{ fit:"fit" } });
}

function effectiveOutput(dest) {
  return dest?.output && typeof dest.output === "object" ? sanitiseOutput(dest.output) : outputFromLegacyLayout(dest?.layout);
}

function orientationFor(output) {
  if (output.mode === "vertical") return "vertical";
  if (output.mode === "custom") return output.height > output.width ? "vertical" : "landscape";
  return "landscape";
}

// Decide where a destination reads from and whether it can stream-copy.
//
//   program = { enabled:boolean, landscape:{width,height,fps,bitrateKbps}, vertical:{...} }
//
// Returns { feed:"raw"|"program", orientation, sceneId, copy, width, height,
// fps, bitrateKbps, framing, legacy, reason }.
function planDestination(dest, program = { enabled:false }) {
  const whip = dest?.transport === "whip";
  if (!dest?.output || typeof dest.output !== "object" || whip) {
    const layout = whip && dest?.layout === "source" ? "landscape" : normaliseLayout(dest?.layout);
    // Exactly the historic routing: every legacy destination reads the
    // composited feed when the compositor is enabled, else the raw input.
    return {
      legacy:true,
      feed:program.enabled ? "program" : "raw",
      orientation:"landscape",
      sceneId:null,
      copy:layout === "source" && !whip,
      layout,
      reason:layout === "source" ? "legacy passthrough of the program feed" : `legacy ${layout} transcode`,
    };
  }
  const output = sanitiseOutput(dest.output);
  if (output.mode === "source") {
    return { legacy:false, feed:"raw", orientation:"landscape", sceneId:null, copy:true, output, reason:"source passthrough (no overlays, stream copy)" };
  }
  const orientation = orientationFor(output);
  const feedInfo = program.enabled ? (program[orientation] || {}) : null;
  if (!program.enabled) {
    // No browser compositor: landscape reads the raw feed; vertical/custom
    // convert the raw 16:9 input with FFmpeg framing (crop/fit/fill/offset).
    const needsTransform = orientation === "vertical" || output.mode === "custom" || output.width || output.height || output.fps || output.videoBitrateKbps || output.videoEncoder !== "auto";
    return {
      legacy:false, feed:"raw", orientation, sceneId:null, copy:!needsTransform, output,
      width:output.width || (orientation === "vertical" ? 1080 : null), height:output.height || (orientation === "vertical" ? 1920 : null),
      fps:output.fps, bitrateKbps:output.videoBitrateKbps, framing:output.framing, transform:orientation === "vertical" || output.mode === "custom" ? "framing" : "scale",
      reason:needsTransform ? "raw input converted by FFmpeg (compositor off)" : "raw passthrough (compositor off)",
    };
  }
  const width = output.width || feedInfo.width, height = output.height || feedInfo.height;
  const fps = output.fps || feedInfo.fps;
  const copy = (!output.width || output.width === feedInfo.width)
    && (!output.height || output.height === feedInfo.height)
    && (!output.fps || output.fps === feedInfo.fps)
    && (!output.videoBitrateKbps || output.videoBitrateKbps === feedInfo.bitrateKbps)
    && output.videoEncoder === "auto"
    && !["server", "burnin"].includes(output.captionMode);
  return {
    legacy:false, feed:"program", orientation, sceneId:output.sceneId, copy, output,
    width, height, fps, bitrateKbps:output.videoBitrateKbps || feedInfo.bitrateKbps || null, transform:"scale",
    reason:copy ? `shares the ${orientation} program encode (stream copy)` : `re-encodes the ${orientation} program to ${width}x${height}@${fps}`,
  };
}

// FFmpeg graph that places a (cropped) 16:9 source into a WxH canvas. Used
// for vertical/custom destinations when the browser compositor is off. The
// background is a blurred cover copy unless CPU-safe mode asks for black.
function framingFilterGraph(framing, W, H, { blurBackground = true, inputLabel = "0:v", outputLabel = "vbase" } = {}) {
  const f = sanitiseFraming(framing);
  const { left:l, right:r, top:t, bottom:b } = f.crop;
  const cw = Math.max(0.05, 1 - l - r), ch = Math.max(0.05, 1 - t - b);
  const crop = `crop=w='trunc(iw*${cw.toFixed(4)}/2)*2':h='trunc(ih*${ch.toFixed(4)}/2)*2':x='iw*${l.toFixed(4)}':y='ih*${t.toFixed(4)}'`;
  const k = f.scale.toFixed(4);
  let fg;
  if (f.fit === "stretch") fg = `scale=w='trunc(${W}*${k}/2)*2':h='trunc(${H}*${k}/2)*2'`;
  else {
    const pick = f.fit === "fit" ? "min" : "max";
    fg = `scale=w='trunc(${pick}(${W}/iw,${H}/ih)*iw*${k}/2)*2':h='trunc(${pick}(${W}/iw,${H}/ih)*ih*${k}/2)*2'`;
  }
  const x = `(main_w-overlay_w)/2+${f.offsetX.toFixed(4)}*main_w`, y = `(main_h-overlay_h)/2+${f.offsetY.toFixed(4)}*main_h`;
  if (blurBackground && f.fit === "fit") {
    return [
      `[${inputLabel}]${crop},split=2[cnbg0][cnfg0]`,
      `[cnbg0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=28[cnbg]`,
      `[cnfg0]${fg}[cnfg]`,
      `[cnbg][cnfg]overlay=x='${x}':y='${y}',setsar=1[${outputLabel}]`,
    ].join(";");
  }
  return [
    `color=c=black:s=${W}x${H}[cnbg]`,
    `[${inputLabel}]${crop},${fg}[cnfg]`,
    `[cnbg][cnfg]overlay=x='${x}':y='${y}':shortest=1,setsar=1[${outputLabel}]`,
  ].join(";");
}

// FFmpeg arguments for a planned (non-legacy) destination. `encoder` is the
// resolved encoder profile (with fallback) chosen by the caller.
function plannedDestinationArgs(sourceUrl, dest, plan, { encoder = null, forceCpu = false } = {}) {
  if (plan.legacy) return destinationFfmpegArgs(sourceUrl, dest, { forceCpu });
  const output = plan.output || sanitiseOutput(dest.output);
  const twitch = isTwitchIngest(dest.url);
  const audio = stableAudioArgs({
    bitrate:output.audioBitrateKbps ? `${output.audioBitrateKbps}k` : (process.env.DESTINATION_AUDIO_BITRATE || "128k"),
    sampleRate:output.audioRate || process.env.DESTINATION_AUDIO_RATE || "44100",
  });
  const mux = [...liveMuxArgs(dest.url, outputFormatFor(dest.url)), dest.url];
  const profile = forceCpu ? { id:"libx264", encoder:"libx264", hardware:false, label:"CPU · x264" } : (encoder || detectEncoder());
  const captions = captionPlan(output.captionMode, { copy:plan.copy, encoderId:profile.encoder, destination:dest, sourceUrl, compositorSource:plan.feed === "program" });

  if (plan.copy) {
    return [
      "-hide_banner", "-loglevel", "warning", ...liveInputArgs({ lowLatency:twitch && plan.feed === "raw" }), "-i", sourceUrl,
      ...captions.inputs,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "copy",
      ...(twitch && plan.feed === "raw" && !output.audioBitrateKbps && !output.audioRate ? ["-c:a", "copy", "-flush_packets", "1"] : audio),
      ...captions.outputArgs,
      ...mux,
    ];
  }

  const W = plan.width || 1920, H = plan.height || 1080;
  const fps = String(plan.fps || Number(process.env.DESTINATION_FPS || 30));
  const cpuSafe = !profile.hardware && piSafeMode({ hardwareEncoder:false });
  const base = plan.transform === "framing"
    ? framingFilterGraph(plan.framing, W, H, { blurBackground:!cpuSafe })
    : `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[vbase]`;
  const burn = captions.videoFilter ? `;[vbase]${captions.videoFilter}[vcap]` : "";
  const filter = `${base}${burn};${encoderFilterSuffix(profile, captions.videoFilter ? "vcap" : "vbase", "v")}`;
  const lowResolution = W <= 1280 && H <= 1280;
  const bitrate = plan.bitrateKbps ? `${plan.bitrateKbps}k` : (process.env.DESTINATION_VIDEO_BITRATE || (lowResolution ? "4000k" : "6000k"));
  const bufsize = plan.bitrateKbps ? `${plan.bitrateKbps * 2}k` : (process.env.DESTINATION_VIDEO_BUFSIZE || (lowResolution ? "8000k" : "12000k"));
  return [
    "-hide_banner", "-loglevel", "warning", ...liveInputArgs({ lowLatency:false }), ...globalEncoderArgs(profile), "-i", sourceUrl,
    ...captions.inputs,
    "-filter_complex", filter,
    "-map", "[v]", "-map", "0:a:0?", ...captions.maps,
    "-r", fps, "-fps_mode", "cfr",
    ...videoEncoderArgs(profile, { fps:Number(fps), bitrate, maxrate:process.env.DESTINATION_VIDEO_MAXRATE || bitrate, bufsize, x264Preset:process.env.DESTINATION_X264_PRESET || cpuX264Preset({ hardwareEncoder:profile.hardware }) }),
    ...captions.outputArgs,
    ...audio,
    ...mux,
  ];
}

// Destinations that transcode the same feed to identical settings can share
// one encode ("rendition"): one FFmpeg encodes, each destination copies it.
function renditionKey(plan, sourcePath) {
  if (plan.legacy || plan.copy) return null;
  const o = plan.output || {};
  return JSON.stringify({ src:sourcePath, t:plan.transform, w:plan.width, h:plan.height, fps:plan.fps, br:plan.bitrateKbps, enc:o.videoEncoder || "auto", fr:plan.transform === "framing" ? plan.framing : null, cc:o.captionMode === "burnin" ? "burnin" : null });
}

function renditionArgs(sourceUrl, plan, outputUrl, { encoder = null, forceCpu = false } = {}) {
  const fake = { url:outputUrl, output:{ ...(plan.output || {}), audioBitrateKbps:160, audioRate:48000 } };
  return plannedDestinationArgs(sourceUrl, fake, { ...plan, copy:false }, { encoder, forceCpu });
}

module.exports = {
  OUTPUT_LAYOUTS, normaliseLayout, outputFormatFor, isTwitchIngest, destinationFfmpegArgs,
  OUTPUT_MODES, FRAMING_FITS, sanitiseOutput, sanitiseFraming, outputFromLegacyLayout, effectiveOutput, orientationFor,
  planDestination, framingFilterGraph, plannedDestinationArgs, renditionKey, renditionArgs,
};
