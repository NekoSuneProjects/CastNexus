"use strict";

const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const Store = require("electron-store");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const downloadManager = require("./download-manager");

// Setup file-based logging for debugging startup issues
const logFile = path.join(os.homedir(), ".castnexus", "startup.log");
function setupLogging() {
  const logDir = path.dirname(logFile);
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => {
    originalLog(...args);
    logStream.write("[INFO] " + args.join(" ") + "\n");
  };
  console.error = (...args) => {
    originalError(...args);
    logStream.write("[ERROR] " + args.join(" ") + "\n");
  };
  process.on('uncaughtException', (err) => {
    console.error("[UNCAUGHT]", err);
    logStream.write("[UNCAUGHT] " + err.message + "\n" + err.stack + "\n");
  });
}
setupLogging();

const isWin = process.platform === "win32";
const store = new Store();

let mainWindow = null;
let setupWindow = null;
let mediaProcess = null;
let music24Service = null;
let shuttingDown = false;

async function ensureToolsAvailable() {
  if (!setupWindow) return false;

  try {
    setupWindow.webContents.send('setup:progress', { status: 'Checking tools...', phase: 'tools' });

    const mediamtx = downloadManager.ensureMediaMTX?.();
    if (!mediamtx) {
      setupWindow.webContents.send('setup:progress', { status: 'Downloading MediaMTX...', phase: 'download-mediamtx' });
      // Trigger actual download through download-manager
      console.log("[setup] MediaMTX will be downloaded...");
    }

    setupWindow.webContents.send('setup:progress', { status: 'Tools ready', phase: 'complete' });
    return true;
  } catch (err) {
    setupWindow.webContents.send('setup:error', { error: err.message });
    return false;
  }
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

async function startMediaMTX() {
  const dataDir = getDataDir();
  const lanIp = store.get("lanIp") || detectLanIp();
  const recordRoot = path.join(dataDir, "recordings").replace(/\\/g, "/");
  const configPath = path.join(dataDir, "mediamtx.yml");

  const config = `logLevel: info
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

  const mtxBin = await downloadManager.ensureMediaMTX();
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
    // Resolve dashboard paths correctly in both dev and packaged contexts
    const dashboardDir = path.join(__dirname, process.env.NODE_ENV === 'development' ? '../dashboard' : '../dashboard');

    try {
      require(path.join(dashboardDir, "public-republish-runtime.js")).installPublicRepublishSpawnPolicy();
      require(path.join(dashboardDir, "server.js"));
      music24Service = require(path.join(dashboardDir, "music24.js"));
      music24Service.startMusic24();

      const port = process.env.DASHBOARD_PORT;
      console.log(`[electron] Dashboard listening on http://localhost:${port}`);
    } catch (err) {
      console.error("[electron] Failed to start dashboard:", err.message);
      throw err;
    }
  }, 1000);
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 600,
    height: 400,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const setupHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>CastNexus Setup</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
        }
        .container {
          background: white;
          border-radius: 12px;
          padding: 40px;
          text-align: center;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 500px;
          width: 100%;
        }
        h1 {
          font-size: 28px;
          margin-bottom: 20px;
          color: #333;
        }
        .status {
          font-size: 16px;
          color: #666;
          margin-bottom: 30px;
          min-height: 60px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .progress-bar {
          width: 100%;
          height: 8px;
          background: #e0e0e0;
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 20px;
        }
        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #667eea, #764ba2);
          width: 0%;
          transition: width 0.3s ease;
        }
        .error {
          color: #d32f2f;
          padding: 15px;
          background: #ffebee;
          border-radius: 8px;
          margin-top: 20px;
          display: none;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>CastNexus</h1>
        <div class="status" id="status">Setting up...</div>
        <div class="progress-bar">
          <div class="progress-fill" id="progress"></div>
        </div>
        <div class="error" id="error"></div>
      </div>
      <script>
        const { ipcRenderer } = require('electron');

        ipcRenderer.on('setup:progress', (event, data) => {
          document.getElementById('status').textContent = data.status;
          if (data.progress) {
            document.getElementById('progress').style.width = (data.progress * 100) + '%';
          }
        });

        ipcRenderer.on('setup:error', (event, data) => {
          const errorEl = document.getElementById('error');
          errorEl.textContent = 'Error: ' + data.error;
          errorEl.style.display = 'block';
        });

        ipcRenderer.on('setup:complete', () => {
          window.close();
        });
      </script>
    </body>
    </html>
  `;

  setupWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(setupHTML)}`);
  setupWindow.show();

  setupWindow.on("closed", () => {
    setupWindow = null;
  });

  return setupWindow;
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

  // Uncomment for development:
  // mainWindow.webContents.openDevTools();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("crashed", () => {
    console.error("[electron] renderer process crashed");
    app.quit();
  });
}

app.on("ready", async () => {
  try {
    console.log("[electron] starting setup...");
    setupEnvironment();
    console.log("[electron] environment ready");

    // Check if tools actually exist (more reliable than setup flag)
    const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    const mediaDir = path.join(downloadManager.TOOLS_DIR, "mediamtx", platform);
    const mediamtxBin = path.join(mediaDir, platform === "windows" ? "mediamtx.exe" : "mediamtx");
    const toolsExist = fs.existsSync(mediamtxBin);
    const isFirstRun = !store.get("setupCompleted") || !toolsExist;

    if (isFirstRun) {
      console.log("[electron] First run or missing tools detected, showing setup wizard...");
      createSetupWindow();

      // Check and download tools if needed
      setTimeout(async () => {
        try {
          if (setupWindow) {
            setupWindow.webContents.send('setup:progress', { status: 'Checking required tools...', progress: 0.2 });

            // Download MediaMTX
            const mediamtx = await downloadManager.ensureMediaMTX((progress) => {
              if (setupWindow && progress) {
                const percent = progress.downloaded / progress.total;
                setupWindow.webContents.send('setup:progress', {
                  status: `Downloading MediaMTX (${Math.round(percent * 100)}%)...`,
                  progress: 0.3 + (percent * 0.3),
                });
              }
            });

            if (!mediamtx) {
              setupWindow?.webContents.send('setup:error', { error: 'Failed to download MediaMTX' });
              return;
            }

            setupWindow.webContents.send('setup:progress', { status: 'Starting services...', progress: 0.7 });

            // Now start services
            await startMediaMTX();
            startDashboard();

            setupWindow.webContents.send('setup:progress', { status: 'Opening dashboard...', progress: 0.95 });

            setTimeout(() => {
              if (setupWindow) setupWindow.close();
              createWindow();
              store.set("setupCompleted", true);
            }, 2000);
          }
        } catch (err) {
          console.error("[electron] setup failed:", err);
          setupWindow?.webContents.send('setup:error', { error: err.message });
        }
      }, 500);
    } else {
      // Normal startup (not first run)
      (async () => {
        await startMediaMTX();
        console.log("[electron] MediaMTX started");

        startDashboard();
        console.log("[electron] Dashboard started");

        console.log("[electron] creating window in 2.5s...");
        setTimeout(createWindow, 2500);
      })().catch(err => {
        console.error("[electron] startup error:", err);
      });
    }
  } catch (err) {
    console.error(`[electron] startup failed: ${err.message}`);
    console.error(`[electron] stack: ${err.stack}`);
    setTimeout(() => {
      app.quit();
    }, 1000);
  }
});

process.on("uncaughtException", (err) => {
  console.error("[electron] uncaught exception:", err);
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
