"use strict";

const path = require("node:path");
const childProcess = require("node:child_process");

const PATCH_FLAG = Symbol.for("castnexus.publicRepublishSpawnPolicy");

function isFfmpeg(command) {
  const base = path.basename(String(command || "")).toLowerCase();
  return base === "ffmpeg" || base === "ffmpeg.exe";
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function isLegacyPublicRepublish(command, args) {
  if (!isFfmpeg(command) || !Array.isArray(args)) return false;
  const input = valueAfter(args, "-i");
  const output = args[args.length - 1];
  return typeof input === "string"
    && input.startsWith("rtmp://127.0.0.1:1935/")
    && typeof output === "string"
    && output.startsWith("rtmp://127.0.0.1:1935/public/")
    && args.includes("-c:v")
    && args[args.indexOf("-c:v") + 1] === "copy"
    && args.includes("-c:a")
    && args[args.indexOf("-c:a") + 1] === "copy";
}

function publicRepublishInputArgs() {
  // This is an internal MediaMTX -> FFmpeg -> MediaMTX hop, not an unknown
  // internet source. The FLV/RTMP stream header already describes H264/AAC,
  // so spending FFmpeg's normal multi-second probe/analyze window is both
  // unnecessary and harmful. On low-FPS Music 24/7 outputs it could delay the
  // public/<login> output socket for ~20s even though profile/<id>/<key> was
  // already live. Keep enough probe bytes for the FLV headers, but start the
  // output immediately once those headers arrive.
  return [
    "-thread_queue_size", String(process.env.RTMP_INPUT_QUEUE || 1024),
    "-fflags", "+genpts+discardcorrupt+nobuffer",
    "-probesize", String(process.env.PUBLIC_REPUBLISH_PROBESIZE || 32768),
    "-analyzeduration", String(process.env.PUBLIC_REPUBLISH_ANALYZE_US || 0),
    "-rtmp_live", "live",
  ];
}

function publicRtspDestination(rtmpDestination){
  const match=String(rtmpDestination||"").match(/^rtmp:\/\/127\.0\.0\.1:1935\/(.+)$/);
  return match?`rtsp://127.0.0.1:8554/${match[1]}`:null;
}

function buildStablePublicRepublishArgs(args) {
  const source = valueAfter(args, "-i");
  const legacyDest = args[args.length - 1];
  const dest = publicRtspDestination(legacyDest);
  return [
    "-hide_banner", "-loglevel", process.env.PUBLIC_REPUBLISH_DEBUG === "true" ? "info" : "warning", "-nostats", "-nostdin",
    ...publicRepublishInputArgs(),
    "-i", source,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-map", "0:a:0?",
    "-c:v", "copy",
    // One public MediaMTX path serves multiple playback protocols. HLS keeps
    // the source AAC track; WebRTC selects the parallel Opus track instead of
    // logging "skipping MPEG-4 Audio" and producing silent video.
    "-c:a:0", "copy",
    "-c:a:1", "libopus",
    "-b:a:1", process.env.PUBLIC_WEBRTC_OPUS_BITRATE || "128k",
    "-ar:a:1", "48000",
    "-ac:a:1", "2",
    "-avoid_negative_ts", "make_zero",
    "-flush_packets", "1",
    "-rtsp_transport", "tcp",
    "-muxdelay", "0.1",
    "-f", "rtsp",
    dest,
  ];
}

function installPublicRepublishSpawnPolicy({ logger = console } = {}) {
  if (childProcess[PATCH_FLAG]) return false;
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = function castNexusSpawn(command, args, options) {
    if (!isLegacyPublicRepublish(command, args)) {
      return originalSpawn.call(this, command, args, options);
    }

    const nextArgs = buildStablePublicRepublishArgs(args);
    const dest = nextArgs[nextArgs.length - 1];
    logger.log?.(`[dashboard] dual-audio public republish -> ${dest.replace(/^rtsp:\/\/127\.0\.0\.1:8554\//, "")} (AAC HLS + Opus WebRTC)`);
    const child = originalSpawn.call(this, command, nextArgs, options);

    if (child?.stderr) {
      child.stderr.on("data", chunk => {
        const line = chunk.toString().trim();
        if (!line) return;
        if (process.env.PUBLIC_REPUBLISH_DEBUG === "true" || /error|failed|invalid|refused|non-monoton|queue|timestamp|probe|analy/i.test(line)) {
          logger.warn?.(`[dashboard] public republish ffmpeg: ${line}`);
        }
      });
    }
    return child;
  };

  childProcess[PATCH_FLAG] = { originalSpawn };
  return true;
}

module.exports = {
  isLegacyPublicRepublish,
  publicRepublishInputArgs,
  buildStablePublicRepublishArgs,
  publicRtspDestination,
  installPublicRepublishSpawnPolicy,
};
