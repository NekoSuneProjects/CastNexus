"use strict";

// Public playback URL construction.
//
// The dashboard is reached three different ways and each needs a different
// answer for "what URL should someone paste into VRChat / VLC / OBS?":
//
//   1. directly on a LAN or server IP (http://192.168.1.10:8090)  -> plain http
//   2. through a reverse proxy on a domain (https://castnexus...) -> keep https
//   3. behind a second proxy that this box cannot see             -> explicit
//                                                                    PUBLIC_BASE_URL
//
// MediaMTX's own paths are never rewritten here: this module only decides the
// scheme/host prefix in front of the existing /hls, /webrtc, RTSP and SRT
// paths that server.js already proxies.

const RTSP_PORT = Number(process.env.PUBLIC_RTSP_PORT || 8554);
const SRT_PORT = Number(process.env.PUBLIC_SRT_PORT || 8890);

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",")[0].trim();
}

function splitHost(host) {
  const value = String(host || "").trim();
  if (!value) return { hostname:"", port:"" };
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) return { hostname:bracketed[1], port:bracketed[2] || "", ipv6:true };
  const colon = value.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) return { hostname:value.slice(0, colon), port:value.slice(colon + 1) };
  return { hostname:value, port:"" };
}

// A bare IP address, localhost or an mDNS name means nobody terminated TLS in
// front of us, so advertising https:// would hand out a URL that cannot open.
function isDirectHostAddress(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":")) return true;
  return false;
}

function normalisePublicBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : `${isDirectHostAddress(splitHost(raw.replace(/\/.*$/, "")).hostname) ? "http" : "https"}://${raw}`;
  let url;
  try { url = new URL(withScheme); } catch { return null; }
  if (!url.host) return null;
  const prefix = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${prefix}`;
}

// Resolve the base URL that public playback links should be built from.
function publicBaseUrl(req, { explicitBase } = {}) {
  const explicit = normalisePublicBase(explicitBase);
  if (explicit) return explicit;
  const headers = req?.headers || {};
  const forwardedHost = firstHeaderValue(headers["x-forwarded-host"]);
  const host = forwardedHost || firstHeaderValue(headers.host) || String(req?.get?.("host") || "");
  const { hostname } = splitHost(host);
  const forwardedProto = firstHeaderValue(headers["x-forwarded-proto"]);
  const protocol = /^https?$/i.test(forwardedProto)
    ? forwardedProto.toLowerCase()
    : (isDirectHostAddress(hostname) ? "http" : (req?.protocol || "http"));
  return `${protocol}://${host}`;
}

function encodePath(safePath) {
  return String(safePath || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

// Friendly, human-facing descriptions. The dashboard used to render the raw
// API keys ("webPlayer", "whep"), which told a VRChat user nothing about which
// of the five URLs they were supposed to paste.
function playbackLinkMeta() {
  return {
    hls:{
      label:"VRChat / media player URL",
      protocol:"HLS",
      hint:"Paste this into a VRChat video player, VLC, or any browser. Most compatible option.",
      primary:true,
      openable:false,
    },
    webPlayer:{
      label:"Browser player",
      protocol:"WebRTC",
      hint:"Opens a low-latency player page in any modern browser.",
      openable:true,
    },
    whep:{
      label:"WHEP endpoint",
      protocol:"WebRTC",
      hint:"For OBS 30+ WHEP sources and other WebRTC ingest clients.",
      openable:false,
    },
    rtsp:{
      label:"RTSP stream",
      protocol:"RTSP",
      hint:"For VLC, ffmpeg and hardware decoders. Needs port 8554 reachable.",
      openable:false,
    },
    srt:{
      label:"SRT stream",
      protocol:"SRT",
      hint:"Low-latency contribution feed for SRT-capable players. Needs port 8890 reachable.",
      openable:false,
    },
  };
}

const PLAYBACK_LINK_ORDER = ["hls", "webPlayer", "whep", "rtsp", "srt"];

function playbackTargets({ base, safePath, mediaHost }) {
  const encoded = encodePath(safePath);
  const prefix = String(base || "").replace(/\/+$/, "");
  const { hostname } = splitHost(prefix.replace(/^https?:\/\//i, "").replace(/\/.*$/, ""));
  const streamHost = mediaHost || hostname || "127.0.0.1";
  const urls = {
    webPlayer:`${prefix}/webrtc/${encoded}`,
    whep:`${prefix}/webrtc/${encoded}/whep`,
    hls:`${prefix}/hls/${encoded}/index.m3u8`,
    rtsp:`rtsp://${streamHost}:${RTSP_PORT}/${safePath}`,
    srt:`srt://${streamHost}:${SRT_PORT}?streamid=read:${safePath}`,
  };
  const meta = playbackLinkMeta();
  return {
    ...urls,
    base:prefix,
    links:PLAYBACK_LINK_ORDER.map(key => ({ key, url:urls[key], ...meta[key] })),
  };
}

module.exports = {
  publicBaseUrl,
  normalisePublicBase,
  playbackTargets,
  playbackLinkMeta,
  isDirectHostAddress,
  splitHost,
  firstHeaderValue,
  PLAYBACK_LINK_ORDER,
  RTSP_PORT,
  SRT_PORT,
};
