#!/usr/bin/env node
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn, execFile } = require("node:child_process");

const isWin = process.platform === "win32";

// When packaged (pkg), executables placed alongside the built binary live
// next to process.execPath. When run with plain `node launcher.js`, fall
// back to this file's own directory.
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;

function detectLanIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
}

const lanIp = process.env.PI_IP || detectLanIp();
const dataDir = process.env.NEKOSUNE_DATA_DIR || path.join(os.homedir(), ".nekosune-ps5-streamer");
fs.mkdirSync(dataDir, { recursive: true });

const mediamtxBin = process.env.MEDIAMTX_BIN || path.join(baseDir, isWin ? "mediamtx.exe" : "mediamtx");
if (!fs.existsSync(mediamtxBin)) {
  console.error(`[launcher] MediaMTX binary not found at ${mediamtxBin}`);
  console.error("[launcher] Download it from https://github.com/bluenviron/mediamtx/releases");
  console.error("[launcher] and place it next to this executable (or set MEDIAMTX_BIN).");
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

console.log(`[launcher] LAN IP detected as ${lanIp} (override with PI_IP env var if wrong)`);
console.log(`[launcher] data dir: ${dataDir}`);
console.log(`[launcher] starting MediaMTX (${mediamtxBin})`);

const mtx = spawn(mediamtxBin, [configPath], { stdio: "inherit" });
mtx.on("error", err => {
  console.error(`[launcher] failed to start MediaMTX: ${err.message}`);
  process.exit(1);
});
mtx.on("exit", code => {
  console.error(`[launcher] MediaMTX exited (code ${code}), shutting down`);
  process.exit(1);
});

process.env.MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
process.env.PI_IP = lanIp;
process.env.STATE_FILE = process.env.STATE_FILE || path.join(dataDir, "state.json");
process.env.DASHBOARD_PORT = process.env.DASHBOARD_PORT || "8090";

// give MediaMTX a moment to bind its ports before the dashboard starts
// polling it
setTimeout(() => {
  require(path.join(__dirname, "..", "dashboard", "server.js"));

  const url = `http://localhost:${process.env.DASHBOARD_PORT}`;
  console.log(`[launcher] dashboard ready at ${url}`);
  console.log("[launcher] note: DNS hijack and the ARP-spoof intercept are not included in the");
  console.log("[launcher] desktop build - this covers the dashboard, media relay, and playback only.");

  if (process.env.NO_OPEN_BROWSER !== "true") {
    if (isWin) execFile("cmd", ["/c", "start", "", url]);
    else if (process.platform === "darwin") execFile("open", [url]);
    else execFile("xdg-open", [url], () => {});
  }
}, 1000);

process.on("SIGINT", () => { mtx.kill(); process.exit(0); });
process.on("SIGTERM", () => { mtx.kill(); process.exit(0); });
