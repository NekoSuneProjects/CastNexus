"use strict";

const OUTPUT_LAYOUTS = ["source", "landscape", "vertical"];

function normaliseLayout(value) {
  return OUTPUT_LAYOUTS.includes(value) ? value : "source";
}

function outputFormatFor(url) {
  return String(url || "").startsWith("srt://") ? "mpegts" : "flv";
}

function destinationFfmpegArgs(sourceUrl, destination) {
  const layout = normaliseLayout(destination.layout);
  const base = ["-hide_banner", "-loglevel", "warning", "-i", sourceUrl, "-map", "0:v:0", "-map", "0:a:0?"];

  if (layout === "source") {
    return [...base, "-c:v", "copy", "-c:a", "copy", "-f", outputFormatFor(destination.url), destination.url];
  }

  const width = layout === "vertical" ? 1080 : 1920;
  const height = layout === "vertical" ? 1920 : 1080;
  const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;

  return [
    ...base,
    "-vf", vf,
    "-r", "30",
    "-c:v", process.env.DESTINATION_VIDEO_ENCODER || "libx264",
    "-preset", process.env.DESTINATION_X264_PRESET || "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level:v", "4.2",
    "-g", "60",
    "-keyint_min", "60",
    "-sc_threshold", "0",
    "-b:v", process.env.DESTINATION_VIDEO_BITRATE || "6000k",
    "-maxrate", process.env.DESTINATION_VIDEO_MAXRATE || "6500k",
    "-bufsize", process.env.DESTINATION_VIDEO_BUFSIZE || "12000k",
    "-c:a", "aac",
    "-b:a", process.env.DESTINATION_AUDIO_BITRATE || "160k",
    "-ar", "48000",
    "-ac", "2",
    "-f", outputFormatFor(destination.url),
    destination.url,
  ];
}

module.exports = { OUTPUT_LAYOUTS, normaliseLayout, outputFormatFor, destinationFfmpegArgs };
