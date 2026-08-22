"use strict";

const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const Store = require("electron-store");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const downloadManager = require("../tools/download-manager");

const isWin = process.platform === "win32";
const store = new Store();

let mainWindow = null;
let mediaProcess = null;
let music24Service = null;
let shuttingDown = false;

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

function setupEnvironment() {
  const dataDir = ensureDataDir();
  const lanIp = store.get("lanIp") || detectLanIp();

  process.env.CASTNEXUS_INSTALL_TYPE = "electron";
  process.env.DASHBOARD_PORT = store.get("dashboardPort") || "8090";
  process.env.STATE_FILE = path.join(dataDir, "state.json");
  process.env.MUSIC_DIR = path.join(dataDir, "music");
  process.env.VOD_DIR = path.join(dataDir, "vod");
  process.env.RECORDINGS_DIR = path.join(dataDir, "recordings");
  process.env.PI_IP = lanIp;
  process.env.MEDIAMTX_API = "http://127.0.0.1:9997";
  process.env.MEDIAMTX_PLAYBACK = "http://127.0.0.1:9996";

  const chromium = downloadManager.findChromium();
  if (chromium && !process.env.PUPPETEER_EXECUTABLE_PATH) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chromium;
  }

  store.set("lanIp", lanIp);
}

function detectLanIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
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
    throw new Error("MediaMTX binary not found and could not be downloaded. Please download from bluenviron/mediamtx");
  }

  console.log(`[electron] starting MediaMTX: ${mtxBin}`);
  mediaProcess = spawn(mtxBin, [configPath]);

  mediaProcess.stdout?.on("data", chunk => {
    console.log(`[mediamtx] ${chunk.toString().trim()}`);
  });

  mediaProcess.stderr?.on("data", chunk => {
    console.log(`[mediamtx] ${chunk.toString().trim()}`);
  });

  mediaProcess.on("error", err => {
    console.error(`[electron] failed to start MediaMTX: ${err.message}`);
    app.quit();
  });

  mediaProcess.on("exit", code => {
    if (shuttingDown) return;
    console.error(`[electron] MediaMTX exited (code ${code}), shutting down`);
    app.quit();
  });
}

function startDashboard() {
  setTimeout(() => {
    require("../dashboard/public-republish-runtime.js").installPublicRepublishSpawnPolicy();
    require("../dashboard/server.js");
    music24Service = require("../dashboard/music24.js");
    music24Service.startMusic24();

    const port = process.env.DASHBOARD_PORT;
    console.log(`[electron] Dashboard listening on http://localhost:${port}`);
  }, 1000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const port = process.env.DASHBOARD_PORT;
  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.webContents.openDevTools();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", async () => {
  try {
    setupEnvironment();
    startMediaMTX();
    startDashboard();

    if (!store.get("setupCompleted")) {
      console.log("[electron] First run detected, showing setup wizard...");
      // Setup will redirect to setup routes in dashboard
    }

    setTimeout(createWindow, 2500);
  } catch (err) {
    console.error(`[electron] startup failed: ${err.message}`);
    app.quit();
  }
});

app.on("window-all-closed", async () => {
  await shutdown();
  app.quit();
});

app.on("before-quit", async () => {
  await shutdown();
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await music24Service?.shutdown?.("shutdown", { exit: false });
  } catch {}

  try {
    mediaProcess?.kill?.();
  } catch {}
}

ipcMain.handle("store:get", (event, key) => {
  return store.get(key);
});

ipcMain.handle("store:set", (event, key, value) => {
  store.set(key, value);
  return true;
});

ipcMain.handle("store:getAll", () => {
  return store.store;
});

module.exports = { app, mainWindow };
