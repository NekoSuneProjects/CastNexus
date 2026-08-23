"use strict";

const { spawn } = require("node:child_process");

const MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
const SOURCE_RTSP = String(process.env.VRCHAT_SOURCE_RTSP || "rtsp://127.0.0.1:8554").replace(/\/+$/, "");
const TARGET_RTSP = String(process.env.VRCHAT_TARGET_RTSP || "rtsp://127.0.0.1:8564").replace(/\/+$/, "");
const POLL_MS = Math.max(500, Number(process.env.VRCHAT_RELAY_POLL_MS || 1500));
const DEBUG = process.env.VRCHAT_RELAY_DEBUG === "true";

const active = new Map();
let wanted = new Set();
let stopping = false;
let pollTimer = null;

function isPublicPath(pathName) {
  return typeof pathName === "string" && pathName.startsWith("public/") && pathName.length > "public/".length;
}

function relayArgs(pathName, { sourceRtsp = SOURCE_RTSP, targetRtsp = TARGET_RTSP } = {}) {
  return [
    "-hide_banner",
    "-loglevel", DEBUG ? "info" : "warning",
    "-nostats",
    "-nostdin",
    "-rtsp_transport", "tcp",
    "-fflags", "+genpts+discardcorrupt+nobuffer",
    "-i", `${sourceRtsp}/${pathName}`,
    // The normal public path intentionally contains AAC + Opus so HLS and
    // WebRTC can share one MediaMTX path. Classic MPEG-TS HLS supports only
    // one audio track, therefore the VRChat branch keeps video plus the first
    // audio track only. CastNexus publishes AAC first and Opus second.
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "copy",
    "-c:a", "copy",
    "-avoid_negative_ts", "make_zero",
    "-flush_packets", "1",
    "-rtsp_transport", "tcp",
    "-muxdelay", "0.1",
    "-f", "rtsp",
    `${targetRtsp}/${pathName}`,
  ];
}

function startRelay(pathName) {
  if (stopping || active.has(pathName) || !isPublicPath(pathName)) return;

  const child = spawn("ffmpeg", relayArgs(pathName), { stdio:["ignore", "ignore", "pipe"] });
  active.set(pathName, child);
  console.log(`[vrchat-relay] ${pathName}: AAC-only RTSP relay started`);

  child.stderr?.on("data", chunk => {
    const text = chunk.toString().trim();
    if (!text) return;
    if (DEBUG || /error|failed|invalid|refused|404|not found|non-monoton|timestamp/i.test(text)) {
      console.warn(`[vrchat-relay] ${pathName}: ${text}`);
    }
  });

  child.on("exit", code => {
    if (active.get(pathName) === child) active.delete(pathName);
    if (!stopping && wanted.has(pathName) && code !== 0) {
      console.warn(`[vrchat-relay] ${pathName}: relay exited with code ${code}; poller will restart it`);
    }
  });
}

function stopRelay(pathName) {
  const child = active.get(pathName);
  if (!child) return;
  active.delete(pathName);
  child.removeAllListeners("exit");
  try { child.kill("SIGTERM"); } catch {}
  console.log(`[vrchat-relay] ${pathName}: relay stopped`);
}

async function syncRelays() {
  if (stopping) return;
  try {
    const response = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
    if (!response.ok) throw new Error(`MediaMTX API returned HTTP ${response.status}`);
    const data = await response.json();
    wanted = new Set((data.items || [])
      .filter(item => item?.ready && isPublicPath(item.name))
      .map(item => item.name));

    for (const pathName of wanted) startRelay(pathName);
    for (const pathName of [...active.keys()]) if (!wanted.has(pathName)) stopRelay(pathName);
  } catch (err) {
    console.warn(`[vrchat-relay] poll failed: ${err.message}`);
  } finally {
    if (!stopping) pollTimer = setTimeout(syncRelays, POLL_MS);
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (pollTimer) clearTimeout(pollTimer);
  wanted = new Set();
  for (const pathName of [...active.keys()]) stopRelay(pathName);
  console.log(`[vrchat-relay] stopped${signal ? ` (${signal})` : ""}`);
}

if (require.main === module) {
  process.on("SIGINT", () => { shutdown("SIGINT"); process.exit(0); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); process.exit(0); });
  console.log(`[vrchat-relay] watching ${MEDIAMTX_API} -> ${TARGET_RTSP}`);
  syncRelays();
}

module.exports = {
  isPublicPath,
  relayArgs,
  syncRelays,
  shutdown,
};
