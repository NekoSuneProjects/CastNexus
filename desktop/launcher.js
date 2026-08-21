#!/usr/bin/env node
"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const https = require("node:https");
const { spawn, execFile } = require("node:child_process");
const buildInfo = require("./build-info.json");

const isWin = process.platform === "win32";
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;

// Desktop release bundles keep MediaMTX, yt-dlp nightly and Deno next to the
// CastNexus executable. Put that directory first so dashboard/profile-vod.js
// resolves those known binaries before anything installed globally.
process.env.PATH = `${baseDir}${path.delimiter}${process.env.PATH || ""}`;
const bundledYtDlp = path.join(baseDir, isWin ? "yt-dlp.exe" : "yt-dlp");
const bundledDeno = path.join(baseDir, isWin ? "deno.exe" : "deno");
if (fs.existsSync(bundledYtDlp)) process.env.YTDLP_BIN = bundledYtDlp;

function detectLanIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
}

function parseVersion(value) {
  const m = String(value || "").replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major:+m[1], minor:+m[2], patch:+m[3], pre:m[4] || "" };
}

function compareIdentifiers(a, b) {
  const aa=String(a||"").split("."), bb=String(b||"").split(".");
  for (let i=0;i<Math.max(aa.length,bb.length);i++) {
    if (aa[i] === undefined) return -1;
    if (bb[i] === undefined) return 1;
    if (aa[i] === bb[i]) continue;
    const an=/^\d+$/.test(aa[i]), bn=/^\d+$/.test(bb[i]);
    if (an && bn) return Number(aa[i]) > Number(bb[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return aa[i] > bb[i] ? 1 : -1;
  }
  return 0;
}

function compareVersion(a, b) {
  const av=parseVersion(a), bv=parseVersion(b);
  if (!av || !bv) return 0;
  for (const k of ["major","minor","patch"]) if (av[k] !== bv[k]) return av[k] > bv[k] ? 1 : -1;
  if (!av.pre && !bv.pre) return 0;
  if (!av.pre) return 1;
  if (!bv.pre) return -1;
  return compareIdentifiers(av.pre,bv.pre);
}

function githubJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: "api.github.com",
      path: pathname,
      headers: { "User-Agent":"CastNexus-Desktop", "Accept":"application/vnd.github+json" },
      timeout: 8000,
    }, res => {
      let body="";
      res.setEncoding("utf8");
      res.on("data", c => body += c);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`GitHub API ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function nativeUpdateNotice(release) {
  const tag = release.tag_name || release.name || "new release";
  const text = `${tag} is available. Open CastNexus to view the release and update instructions.`;
  if (isWin) {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$n=New-Object System.Windows.Forms.NotifyIcon",
      "$n.Icon=[System.Drawing.SystemIcons]::Information",
      "$n.Visible=$true",
      "$n.BalloonTipTitle='CastNexus update available'",
      `$n.BalloonTipText='${text.replace(/'/g,"''")}'`,
      "$n.ShowBalloonTip(8000)",
      "Start-Sleep -Seconds 9",
      "$n.Dispose()",
    ].join(";");
    const child = spawn("powershell.exe", ["-NoProfile","-WindowStyle","Hidden","-Command",script], { detached:true, stdio:"ignore" });
    child.unref();
  } else if (process.platform === "linux") {
    const child = spawn("notify-send", ["CastNexus update available", text], { detached:true, stdio:"ignore" });
    child.on("error", () => {});
    child.unref();
  }
}

async function checkForUpdate() {
  if (!parseVersion(buildInfo.version) || buildInfo.channel === "dev") return;
  try {
    const releases = await githubJson(`/repos/${buildInfo.repository}/releases?per_page=20`);
    const candidates = (releases || []).filter(r => !r.draft);
    const release = buildInfo.channel === "beta" ? candidates[0] : candidates.find(r => !r.prerelease);
    if (release?.tag_name && compareVersion(release.tag_name, buildInfo.version) > 0) {
      console.log(`[CastNexus] update available: ${release.tag_name} (installed ${buildInfo.version}/${buildInfo.channel})`);
      nativeUpdateNotice(release);
    }
  } catch (e) {
    console.log(`[CastNexus] update check skipped: ${e.message}`);
  }
}

const lanIp = process.env.PI_IP || detectLanIp();
const legacyDataDir = path.join(os.homedir(), ".nekosune-ps5-streamer");
const defaultDataDir = path.join(os.homedir(), ".castnexus");
const dataDir = process.env.CASTNEXUS_DATA_DIR || process.env.NEKOSUNE_DATA_DIR || (!fs.existsSync(defaultDataDir) && fs.existsSync(legacyDataDir) ? legacyDataDir : defaultDataDir);
fs.mkdirSync(dataDir, { recursive:true });

const mediamtxBin = process.env.MEDIAMTX_BIN || path.join(baseDir, isWin ? "mediamtx.exe" : "mediamtx");
if (!fs.existsSync(mediamtxBin)) {
  console.error(`[CastNexus] MediaMTX binary not found at ${mediamtxBin}`);
  console.error("[CastNexus] place mediamtx next to this executable or set MEDIAMTX_BIN.");
  process.exit(1);
}

const configPath = path.join(dataDir, "mediamtx.yml");
fs.writeFileSync(configPath, `
logLevel: info

rtmp: yes
rtmpAddress: :1935

rtsp: yes
rtspAddress: :8554
rtpAddress: :8000
rtcpAddress: :8001

hls: yes
hlsAddress: :8888
hlsVariant: lowLatency
hlsAllowOrigins:
  - '*'

webrtc: yes
webrtcAddress: :8889
webrtcAdditionalHosts:
  - ${lanIp}

srt: yes
srtAddress: :8890

api: yes
apiAddress: 127.0.0.1:9997

paths:
  all_others:
`.trimStart());

process.env.CASTNEXUS_VERSION = buildInfo.version;
process.env.CASTNEXUS_CHANNEL = buildInfo.channel;
process.env.CASTNEXUS_INSTALL_TYPE = "desktop";
process.env.MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
process.env.PI_IP = lanIp;
process.env.STATE_FILE = process.env.STATE_FILE || path.join(dataDir, "state.json");
process.env.DASHBOARD_PORT = process.env.DASHBOARD_PORT || "8090";

console.log(`[CastNexus] ${buildInfo.version} (${buildInfo.channel})`);
console.log(`[CastNexus] LAN IP: ${lanIp}`);
console.log(`[CastNexus] data directory: ${dataDir}`);
console.log(`[CastNexus] starting MediaMTX: ${mediamtxBin}`);
if (fs.existsSync(bundledYtDlp)) console.log(`[CastNexus] yt-dlp: ${bundledYtDlp}`);
else console.warn("[CastNexus] bundled yt-dlp not found; Twitch/YouTube VOD URL resolving needs yt-dlp in PATH.");
if (fs.existsSync(bundledDeno)) console.log(`[CastNexus] Deno: ${bundledDeno}`);
else console.warn("[CastNexus] bundled Deno not found; YouTube URL resolving may be incomplete.");
checkForUpdate();

const mtx = spawn(mediamtxBin, [configPath], { stdio:"inherit" });
mtx.on("error", err => {
  console.error(`[CastNexus] failed to start MediaMTX: ${err.message}`);
  process.exit(1);
});
mtx.on("exit", code => {
  console.error(`[CastNexus] MediaMTX exited (code ${code}), shutting down`);
  process.exit(1);
});

setTimeout(() => {
  // Static require is intentional: @yao-pkg/pkg can trace and bundle the
  // dashboard server/dependencies into the Windows/Linux CastNexus binary.
  require("../dashboard/server.js");

  const url = `http://localhost:${process.env.DASHBOARD_PORT}`;
  console.log(`[CastNexus] Studio ready at ${url}`);
  console.log("[CastNexus] desktop mode includes dashboard/media relay, profile VOD reruns and yt-dlp/Deno URL resolving. Console DNS/intercept remains Docker/Linux-specific.");

  if (process.env.NO_OPEN_BROWSER !== "true") {
    if (isWin) execFile("cmd", ["/c","start","",url]);
    else if (process.platform === "darwin") execFile("open", [url]);
    else execFile("xdg-open", [url], () => {});
  }
}, 1000);

process.on("SIGINT", () => { mtx.kill(); process.exit(0); });
process.on("SIGTERM", () => { mtx.kill(); process.exit(0); });
