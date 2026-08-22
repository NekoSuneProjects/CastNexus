"use strict";

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const Store = require("electron-store");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const downloadManager = require("./download-manager");
const { selectFfmpeg } = require("./ffmpeg-selector");
const oauthBridge = require("./oauth-bridge");
const OFFICIAL_OAUTH_BROKER = "https://castnexus.nekosunevr.co.uk/oauth";
const APP_ICON = path.join(__dirname, "assets", "icon.png");

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
}
setupLogging();

const store = new Store();

let mainWindow = null;
let setupWindow = null;
let loadingWindow = null;
let mediaProcess = null;
let music24Service = null;
let shuttingDown = false;

// Guards the window-all-closed handler. Closing the loading window to open the
// setup wizard (or the wizard to open the dashboard) momentarily leaves zero
// windows open, which would otherwise quit the whole app mid-setup.
let windowTransition = false;

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

function detectLanIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
}

function getPort() {
  return String(store.get("dashboardPort") || 8090);
}

// The dashboard reads all of its config from process.env, exactly as it does
// under Docker. electron-store is just a different source for the same values.
function setupEnvironment() {
  const dataDir = ensureDataDir();
  const lanIp = store.get("lanIp") || detectLanIp();
  const port = getPort();
  const tools = downloadManager.getToolPaths();

  process.env.CASTNEXUS_INSTALL_TYPE = "electron";
  process.env.DASHBOARD_PORT = port;
  process.env.STATE_FILE = path.join(dataDir, "state.json");
  process.env.MUSIC_DIR = path.join(dataDir, "music");
  process.env.VOD_DIR = path.join(dataDir, "vod");
  process.env.RECORDINGS_DIR = path.join(dataDir, "recordings");
  process.env.PI_IP = lanIp;
  process.env.MEDIAMTX_API = "http://127.0.0.1:9997";
  process.env.MEDIAMTX_PLAYBACK = "http://127.0.0.1:9996";
  if (process.env.CASTNEXUS_OAUTH_MODE === "local") process.env.CASTNEXUS_OAUTH_BROKER_URL = "";
  else process.env.CASTNEXUS_OAUTH_BROKER_URL =
    process.env.CASTNEXUS_OAUTH_BROKER_URL || store.get("oauth_broker_url") || OFFICIAL_OAUTH_BROKER;

  // Twitch credentials collected by the setup wizard. Without these the
  // dashboard answers "TWITCH_CLIENT_ID is not configured" on every OAuth hit.
  const twitchId = store.get("twitch_client_id");
  const twitchSecret = store.get("twitch_client_secret");
  if (twitchId) process.env.TWITCH_CLIENT_ID = String(twitchId);
  if (twitchSecret) process.env.TWITCH_CLIENT_SECRET = String(twitchSecret);

  // Sign-in happens in the system browser, so the provider must redirect to a
  // loopback port Electron owns rather than to the dashboard itself — see
  // oauth-bridge.js for why. This URI is what has to be registered in the
  // Twitch/Google developer console.
  process.env.TWITCH_REDIRECT_URI =
    store.get("twitch_redirect_uri") || oauthBridge.getRedirectUri("twitch", port);
  process.env.YOUTUBE_REDIRECT_URI =
    store.get("youtube_redirect_uri") || oauthBridge.getRedirectUri("youtube", port);

  // Prefer the bundled tool, unless its NVENC API is newer than the installed
  // NVIDIA driver and the system FFmpeg can encode successfully. This is
  // common on older Maxwell cards that remain perfectly capable of H.264.
  if (downloadManager.hasUsableBinary(tools.ffmpeg)) {
    const selectedFfmpeg = selectFfmpeg({ bundled:tools.ffmpeg });
    process.env.FFMPEG_BIN = selectedFfmpeg.binary;
    console.log(`[electron] FFmpeg: ${selectedFfmpeg.source}${selectedFfmpeg.nvenc ? " · NVENC ready" : " · hardware probe deferred"}`);
    if (selectedFfmpeg.fallbackReason && selectedFfmpeg.source === "system") console.warn("[electron] bundled FFmpeg NVENC incompatible; using working system FFmpeg");
  }
  if (downloadManager.hasUsableBinary(tools.ffprobe)) process.env.FFPROBE_BIN = tools.ffprobe;
  if (downloadManager.hasUsableBinary(tools.ytdlp)) process.env.YTDLP_BIN = tools.ytdlp;
  if (downloadManager.hasUsableBinary(tools.deno)) process.env.DENO_BIN = tools.deno;

  const chromium = downloadManager.findChromium();
  if (chromium && !process.env.PUPPETEER_EXECUTABLE_PATH) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chromium;
  }

  store.set("lanIp", lanIp);
  store.set("dataDir", dataDir);
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
    throw new Error("MediaMTX binary not found and could not be downloaded");
  }

  console.log(`[electron] starting MediaMTX: ${mtxBin}`);
  // cwd must be writable — MediaMTX writes auto.key/auto.crt beside the cwd,
  // and the install dir under Program Files is read-only.
  mediaProcess = spawn(mtxBin, [configPath], { cwd: dataDir });

  mediaProcess.stdout?.on("data", chunk => console.log(`[mediamtx] ${chunk.toString().trim()}`));
  mediaProcess.stderr?.on("data", chunk => console.log(`[mediamtx] ${chunk.toString().trim()}`));

  mediaProcess.on("error", err => {
    console.error(`[electron] failed to start MediaMTX: ${err.message}`);
  });

  mediaProcess.on("exit", code => {
    mediaProcess = null;
    if (shuttingDown) return;
    console.error(`[electron] MediaMTX exited (code ${code})`);
  });
}

function resolveDashboardPath() {
  // Packaged: main.js lives inside app.asar, dashboard is unpacked next to it
  // via extraFiles, i.e. <app root>/dashboard. Dev: ../dashboard.
  return __dirname.includes("app.asar")
    ? path.join(__dirname, "../../dashboard")
    : path.join(__dirname, "../dashboard");
}

function startDashboard() {
  const dashboardPath = resolveDashboardPath();
  console.log(`[electron] Loading dashboard from: ${dashboardPath}`);

  require(path.join(dashboardPath, "public-republish-runtime.js")).installPublicRepublishSpawnPolicy();
  require(path.join(dashboardPath, "server.js"));
  music24Service = require(path.join(dashboardPath, "music24.js"));
  music24Service.startMusic24();

  console.log(`[electron] Dashboard starting on http://localhost:${getPort()}`);
}

// Poll until the Express server actually accepts connections. Loading the
// window before this shows ERR_CONNECTION_REFUSED instead of the dashboard.
function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: "127.0.0.1", port: Number(port), path: "/", timeout: 2000 }, res => {
        res.resume();
        resolve(true);
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error(`Dashboard did not start within ${timeoutMs}ms`));
      setTimeout(probe, 300);
    };
    probe();
  });
}

function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 600,
    height: 400,
    center: true,
    resizable: false,
    show: false,
    title: "CastNexus Setup",
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });

  const loadingHTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>CastNexus Setup</title>
<style>
  :root { --text:#f4f6ff; --muted-2:#687187; --purple:#7c5cff; --cyan:#38e8ff; --border:rgba(255,255,255,.085); }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; width:100%; }
  body {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background:
      radial-gradient(circle at 16% -10%, rgba(124,92,255,.12), transparent 34%),
      radial-gradient(circle at 92% 12%, rgba(56,232,255,.07), transparent 28%),
      linear-gradient(180deg,#080a12,#060810 70%);
    color: var(--text); display:flex; align-items:center; justify-content:center; overflow:hidden;
  }
  .container {
    width:min(100%,520px); margin:0 24px; border-radius:28px; padding:42px;
    background: linear-gradient(180deg, rgba(20,24,40,.82), rgba(12,15,27,.76));
    border:1px solid var(--border);
    box-shadow: 0 24px 70px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.03);
    text-align:center; position:relative; overflow:hidden;
  }
  .container::before {
    content:""; position:absolute; inset:0 auto auto 0; width:100%; height:2px;
    background: linear-gradient(90deg, transparent, var(--purple), var(--cyan), transparent);
  }
  h1 { font-size:28px; margin-bottom:8px; }
  .eyebrow { color:var(--muted-2); font-size:.68rem; letter-spacing:.22em; font-weight:800; text-transform:uppercase; margin-bottom:16px; }
  .status { font-size:14px; margin-bottom:12px; min-height:40px; display:flex; align-items:center; justify-content:center; }
  .progress-bar { width:100%; height:6px; background:var(--border); border-radius:3px; overflow:hidden; margin-bottom:10px; }
  .progress-fill { height:100%; width:0%; background:linear-gradient(90deg,var(--purple),var(--cyan)); transition:width .3s ease; box-shadow:0 0 12px rgba(124,92,255,.4); }
  .detail { font-size:12px; color:var(--muted-2); min-height:16px; }
</style></head>
<body>
  <div class="container">
    <div class="eyebrow">Setup</div>
    <h1>CastNexus</h1>
    <div class="status" id="status">Starting…</div>
    <div class="progress-bar"><div class="progress-fill" id="progress"></div></div>
    <div class="detail" id="detail"></div>
  </div>
</body></html>`;

  loadingWindow.loadURL("data:text/html;charset=UTF-8," + encodeURIComponent(loadingHTML));
  loadingWindow.once("ready-to-show", () => loadingWindow?.show());
  loadingWindow.on("closed", () => { loadingWindow = null; });

  return loadingWindow;
}

let lastLoggedStatus = "";
function setLoadingStatus(message, fraction, detail = "") {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  // Progress callbacks fire per chunk; only log when the rendered state changes
  // or the log fills with thousands of identical lines.
  const key = `${message}|${pct}`;
  if (key !== lastLoggedStatus) {
    lastLoggedStatus = key;
    console.log(`[setup] ${message} (${pct}%)`);
  }
  if (!loadingWindow || loadingWindow.isDestroyed()) return;
  const js = `
    (() => {
      const s = document.getElementById('status');
      const p = document.getElementById('progress');
      const d = document.getElementById('detail');
      if (s) s.textContent = ${JSON.stringify(message)};
      if (p) p.style.width = '${pct}%';
      if (d) d.textContent = ${JSON.stringify(detail)};
    })();
  `;
  loadingWindow.webContents.executeJavaScript(js).catch(() => {});
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 650,
    height: 780,
    center: true,
    show: false,
    title: "CastNexus Setup",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  setupWindow.loadFile(path.join(__dirname, "setup.html"));
  setupWindow.once("ready-to-show", () => setupWindow?.show());

  setupWindow.on("closed", () => {
    setupWindow = null;
    if (!store.get("setupWizardFinished")) return;

    console.log("[electron] Setup wizard finished, starting services");
    store.set("setupCompleted", true);
    windowTransition = true;
    // The dashboard must be required *after* this point: server.js reads
    // TWITCH_CLIENT_ID and friends into module-level consts at require time,
    // so starting it before the wizard collected them freezes empty values.
    startServices()
      .then(() => openMainWindow())
      .catch(err => console.error("[electron] post-setup start failed:", err.stack || err.message))
      .finally(() => { windowTransition = false; });
  });

  return setupWindow;
}

let loginInFlight = null;
async function runExternalLogin(provider, port) {
  if (loginInFlight) {
    console.log("[oauth] a sign-in is already in progress");
    return;
  }
  loginInFlight = provider;
  try {
    await oauthBridge.beginLogin(provider, {
      dashboardPort: port,
      session: mainWindow.webContents.session,
    });
    mainWindow?.loadURL(`http://localhost:${port}/dashboard`);
    mainWindow?.focus();
  } catch (err) {
    console.error(`[oauth] ${provider} sign-in failed: ${err.message}`);
    const msg = JSON.stringify(`${provider} sign-in failed: ${err.message}`);
    mainWindow?.webContents.executeJavaScript(`window.alert(${msg});`).catch(() => {});
  } finally {
    loginInFlight = null;
  }
}

async function openMainWindow() {
  const port = getPort();
  try {
    await waitForServer(port);
  } catch (err) {
    console.error("[electron] " + err.message);
  }

  mainWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: "CastNexus Studio",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // localhost, not 127.0.0.1 — the Twitch OAuth redirect URI uses localhost and
  // the origins must match or the session cookie is dropped on callback.
  mainWindow.loadURL(`http://localhost:${port}/dashboard`);
  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Sign-in must happen in the user's real browser, and anything else pointing
  // off-app opens there too rather than in a chrome-less Electron window.
  const handleExternal = (url) => {
    const provider = process.env.CASTNEXUS_OAUTH_BROKER_URL ? null : oauthBridge.matchProvider(url, port);
    if (provider) {
      runExternalLogin(provider, port);
      return true;
    }
    if (!url.startsWith(`http://localhost:${port}`)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  };

  mainWindow.webContents.setWindowOpenHandler(({ url }) =>
    handleExternal(url) ? { action: "deny" } : { action: "allow" });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (handleExternal(url)) event.preventDefault();
  });

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[electron] renderer process gone: ${details.reason}`);
  });

  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow;
}

async function downloadRequiredTools() {
  setLoadingStatus("Checking required tools…", 0.05);

  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  const step = (label, from, to) => (p) => {
    if (!p || !p.total) return;
    const frac = Math.min(1, p.downloaded / p.total);
    setLoadingStatus(`Installing ${label}…`, from + frac * (to - from),
      `${mb(p.downloaded)} MB of ${mb(p.total)} MB`);
  };

  setLoadingStatus("Installing MediaMTX…", 0.10, "streaming server");
  const mediamtx = await downloadManager.ensureMediaMTX(step("MediaMTX", 0.10, 0.30));
  if (!mediamtx) throw new Error("MediaMTX could not be downloaded");

  setLoadingStatus("Installing FFmpeg…", 0.30, "video encoder");
  const ffmpeg = await downloadManager.ensureFFmpeg(step("FFmpeg", 0.30, 0.55));
  if (!ffmpeg) console.warn("[setup] FFmpeg unavailable — falling back to system PATH");

  setLoadingStatus("Installing yt-dlp…", 0.55, "media downloader");
  const ytdlp = await downloadManager.ensureYtDlp(step("yt-dlp", 0.55, 0.68));
  if (!ytdlp) console.warn("[setup] yt-dlp unavailable");

  setLoadingStatus("Installing Deno…", 0.68, "script runtime");
  const deno = await downloadManager.ensureDeno(step("Deno", 0.68, 0.80));
  if (!deno) console.warn("[setup] Deno unavailable");

  return { mediamtx, ffmpeg, ytdlp, deno };
}

// Starts MediaMTX + the Express dashboard. Reads config from process.env, so
// setupEnvironment() must have run with final settings before this is called.
let servicesStarted = false;
async function startServices() {
  if (servicesStarted) return;
  servicesStarted = true;
  setupEnvironment();
  await startMediaMTX();
  startDashboard();
  // Bind the sign-in loopback port now so a conflict shows up at startup
  // rather than the first time someone clicks Login.
  await oauthBridge.startCallbackServer(getPort())
    .catch(err => console.error(`[oauth] ${err.message}`));
}

async function runFirstRunFlow() {
  createLoadingWindow();

  try {
    await downloadRequiredTools();
    setLoadingStatus("Ready", 1, "Opening setup…");

    // Open the next window BEFORE closing this one so the window count never
    // hits zero (which would fire window-all-closed and quit the app).
    windowTransition = true;
    createSetupWindow();
    setupWindow.once("ready-to-show", () => {
      loadingWindow?.close();
      windowTransition = false;
    });
  } catch (err) {
    console.error("[electron] setup failed:", err.stack || err.message);
    setLoadingStatus(`Setup failed: ${err.message}`, 1, "See ~/.castnexus/startup.log");
  }
}

async function runNormalStartup() {
  await startServices();
  await openMainWindow();
}

app.on("ready", async () => {
  try {
    console.log("[electron] starting…");
    setupEnvironment();

    const tools = downloadManager.getToolPaths();
    // Check the path the download manager actually writes to. The old check
    // looked in a per-platform subfolder that is never created, so every launch
    // was treated as a first run.
    const toolsReady = downloadManager.hasUsableBinary(tools.mediamtx);
    const isFirstRun = !store.get("setupCompleted") || !toolsReady;

    console.log(`[electron] setupCompleted=${!!store.get("setupCompleted")} mediamtxPresent=${toolsReady} firstRun=${isFirstRun}`);

    if (isFirstRun) {
      await runFirstRunFlow();
    } else {
      await runNormalStartup();
    }
  } catch (err) {
    console.error(`[electron] startup failed: ${err.message}`);
    console.error(`[electron] stack: ${err.stack}`);
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0 && store.get("setupCompleted")) {
    await openMainWindow();
  }
});

app.on("window-all-closed", async () => {
  if (windowTransition) {
    console.log("[electron] window transition in progress, staying alive");
    return;
  }
  await shutdown();
  app.quit();
});

app.on("before-quit", async () => {
  await shutdown();
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[electron] shutting down");

  try { oauthBridge.stopCallbackServer(); } catch {}
  try { await music24Service?.shutdown?.("shutdown", { exit: false }); } catch {}
  try { mediaProcess?.kill?.(); } catch {}
}

process.on("uncaughtException", (err) => {
  console.error("[electron] uncaught exception:", err.stack || err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[electron] unhandled rejection:", reason);
});

ipcMain.handle("store:get", (_event, key) => store.get(key));

ipcMain.handle("store:set", (_event, key, value) => {
  store.set(key, value);
  return true;
});

ipcMain.handle("store:getAll", () => store.store);

ipcMain.handle("app:getInfo", () => ({
  dataDir: getDataDir(),
  port: getPort(),
  redirectUri: process.env.TWITCH_REDIRECT_URI,
  version: app.getVersion(),
}));

module.exports = { app };
