"use strict";

const { detectEncoder, globalEncoderArgs, encoderFilterSuffix, videoEncoderArgs } = require("./gpu-encoder");

const OUTPUT_LAYOUTS = ["source", "landscape", "vertical"];

function normaliseLayout(value) {
  return OUTPUT_LAYOUTS.includes(value) ? value : "source";
}

function outputFormatFor(url) {
  return String(url || "").startsWith("srt://") ? "mpegts" : "flv";
}

function destinationFfmpegArgs(sourceUrl, destination, options = {}) {
  const layout = normaliseLayout(destination.layout);
  const profile = options.forceCpu ? { id:"libx264", encoder:"libx264", hardware:false, label:"CPU · x264" } : detectEncoder();
  const input = ["-hide_banner", "-loglevel", "warning", ...globalEncoderArgs(profile), "-i", sourceUrl];

  if (layout === "source") {
    return [...input, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "copy", "-f", outputFormatFor(destination.url), destination.url];
  }

  const width = layout === "vertical" ? 1080 : 1920;
  const height = layout === "vertical" ? 1920 : 1080;
  const fps = String(process.env.DESTINATION_FPS || 30);
  const filter = [
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
    ...videoEncoderArgs(profile, {
      fps:Number(fps),
      bitrate:process.env.DESTINATION_VIDEO_BITRATE || "6000k",
      maxrate:process.env.DESTINATION_VIDEO_MAXRATE || "6500k",
      bufsize:process.env.DESTINATION_VIDEO_BUFSIZE || "12000k",
      x264Preset:process.env.DESTINATION_X264_PRESET || "veryfast",
    }),
    "-c:a", "aac",
    "-b:a", process.env.DESTINATION_AUDIO_BITRATE || "160k",
    "-ar", "48000",
    "-ac", "2",
    "-f", outputFormatFor(destination.url),
    destination.url,
  ];
}

module.exports = { OUTPUT_LAYOUTS, normaliseLayout, outputFormatFor, destinationFfmpegArgs };
