#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const Store = require("electron-store");

const downloadManager = require("../tools/download-manager");
const OFFICIAL_OAUTH_BROKER = "https://castnexus.nekosunevr.co.uk/oauth";
const isWin = process.platform === "win32";

const store = new Store({
  name: "castnexus-cli",
  cwd: path.join(os.homedir(), ".castnexus"),
});

let mediaProcess = null;
let music24Service = null;
let shuttingDown = false;

function detectLanIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
}

function getDataDir() {
  return store.get("dataDir") || path.join(os.homedir(), ".castnexus");
}

function ensureDataDir() {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "music"), { recursive: true });
  fs.mkdirSync(path.join(dir, "vod"), { recursive: true });
  fs.mkdirSync(path.join(dir, "recordings"), { recursive: true });
  return dir;
}

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  content.split("\n").forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
    process.env[key.trim()] = value;
  });
}

function setupEnvironment() {
  loadDotEnv();

  const dataDir = process.env.STATE_FILE ? path.dirname(process.env.STATE_FILE) : ensureDataDir();
  const lanIp = process.env.PI_IP || store.get("lanIp") || detectLanIp();

  process.env.CASTNEXUS_INSTALL_TYPE = process.env.CASTNEXUS_INSTALL_TYPE || "cli";
  process.env.DASHBOARD_PORT = process.env.DASHBOARD_PORT || store.get("dashboardPort") || "8090";
  process.env.STATE_FILE = process.env.STATE_FILE || path.join(dataDir, "state.json");
  process.env.MUSIC_DIR = process.env.MUSIC_DIR || path.join(dataDir, "music");
  process.env.VOD_DIR = process.env.VOD_DIR || path.join(dataDir, "vod");
  process.env.RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(dataDir, "recordings");
  process.env.PI_IP = lanIp;
  process.env.MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
  process.env.MEDIAMTX_PLAYBACK = process.env.MEDIAMTX_PLAYBACK || "http://127.0.0.1:9996";
  if (process.env.CASTNEXUS_OAUTH_MODE === "local") process.env.CASTNEXUS_OAUTH_BROKER_URL = "";
  else process.env.CASTNEXUS_OAUTH_BROKER_URL = process.env.CASTNEXUS_OAUTH_BROKER_URL || store.get("oauthBrokerUrl") || OFFICIAL_OAUTH_BROKER;
  process.env.TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || store.get("twitchClientId") || "";
  process.env.TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || store.get("twitchClientSecret") || "";
  process.env.TWITCH_REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || store.get("twitchRedirectUri") || `http://${lanIp}:${process.env.DASHBOARD_PORT}/auth/twitch/callback`;

  const chromium = downloadManager.findChromium();
  if (chromium && !process.env.PUPPETEER_EXECUTABLE_PATH) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chromium;
  }

  store.set("lanIp", lanIp);
}

function startMediaMTX() {
  const dataDir = getDataDir();
  const lanIp = store.get("lanIp") || detectLanIp();
  const recordRoot = path.join(dataDir, "recordings").replace(/\\/g, "/");
  const configPath = path.join(dataDir, "mediamtx.yml");

  const config = `logLevel: info
rtmp: yes
rtmpAddress: :1935
rtsp: yes
rtspAddress: :8554
rtp: yes
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
playback: yes
playbackAddress: 127.0.0.1:9996
pathDefaults:
  record: no
  recordPath: ${recordRoot}/%path/%Y-%m-%d_%H-%M-%S-%f
  recordFormat: fmp4
  recordPartDuration: 1s
  recordMaxPartSize: 50M
  recordSegmentDuration: 1h
  recordDeleteAfter: 0s
paths:
  all_others:
`;

  fs.writeFileSync(configPath, config.trim() + "\n");

  const mtxBin = downloadManager.ensureMediaMTX();
  if (!mtxBin) {
    console.error("[cli] MediaMTX binary not found. Download from bluenviron/mediamtx");
    process.exit(1);
  }

  console.log(`[cli] Starting MediaMTX: ${mtxBin}`);
  mediaProcess = spawn(mtxBin, [configPath], { stdio: "inherit" });

  mediaProcess.on("error", err => {
    console.error(`[cli] failed to start MediaMTX: ${err.message}`);
    process.exit(1);
  });

  mediaProcess.on("exit", code => {
    if (shuttingDown) return;
    console.error(`[cli] MediaMTX exited (code ${code}), shutting down`);
    process.exit(1);
  });
}

function startDashboard() {
  setTimeout(() => {
    require("../dashboard/public-republish-runtime.js").installPublicRepublishSpawnPolicy();
    require("../dashboard/server.js");
    music24Service = require("../dashboard/music24.js");
    music24Service.startMusic24();

    const port = process.env.DASHBOARD_PORT;
    const lanIp = store.get("lanIp") || detectLanIp();
    console.log(`\n✓ CastNexus Dashboard ready at http://localhost:${port}`);
    console.log(`✓ LAN access: http://${lanIp}:${port}`);
    console.log(`✓ Music 24/7 worker started\n`);
  }, 1000);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await music24Service?.shutdown?.("shutdown", { exit: false });
  } catch {}

  try {
    mediaProcess?.kill?.();
  } catch {}

  process.exit(0);
}

// CLI startup
console.log("\n🎬 CastNexus CLI Launcher");
console.log("========================\n");

const args = process.argv.slice(2);

if (args.includes("--setup")) {
  console.log("Setting up CastNexus CLI...");
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const questions = [
    { key: "twitchClientId", prompt: "Twitch Client ID: " },
    { key: "twitchClientSecret", prompt: "Twitch Client Secret: " },
    { key: "twitchRedirectUri", prompt: "Twitch Redirect URI (default: http://localhost:8090/auth/twitch/callback): ", default: "http://localhost:8090/auth/twitch/callback" },
    { key: "dashboardPort", prompt: "Dashboard Port (default: 8090): ", default: "8090" },
  ];

  let questionIndex = 0;

  function askQuestion() {
    if (questionIndex >= questions.length) {
      rl.close();
      console.log("\n✓ Setup complete! Run 'castnexus-cli' to start.\n");
      process.exit(0);
    }

    const q = questions[questionIndex];
    rl.question(q.prompt, answer => {
      store.set(q.key, answer || q.default || "");
      questionIndex++;
      askQuestion();
    });
  }

  askQuestion();
} else {
  setupEnvironment();
  startMediaMTX();
  startDashboard();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  console.log(`[cli] ${store.get("twitchClientId") ? "✓ Configured" : "⚠ Not configured - run with --setup"}`);
}
