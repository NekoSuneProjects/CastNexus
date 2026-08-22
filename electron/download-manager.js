"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { createWriteStream, promises: fsPromises } = require("node:fs");
const { pipeline } = require("node:stream/promises");

// In packaged app, tools are in app/ (outside asar); in dev, they're in ../tools
const TOOLS_DIR = process.env.NODE_ENV === 'development'
  ? path.join(__dirname, '../tools')
  : path.join(__dirname, '../../tools');

function getPlatformArch() {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "x86";
  return { platform, arch };
}

async function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const file = createWriteStream(outputPath);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        file.destroy();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      pipeline(res, file).then(resolve).catch(reject);
    }).on("error", reject);
  });
}

function ensureFFmpeg() {
  const { platform } = getPlatformArch();
  const binName = platform === "windows" ? "ffmpeg.exe" : "ffmpeg";
  const ffmpegPath = path.join(TOOLS_DIR, "ffmpeg", platform, binName);

  if (fs.existsSync(ffmpegPath)) return ffmpegPath;

  console.log("[tools] FFmpeg not found, would download from ffmpeg.org (TODO: implement actual download)");
  return null;
}

function ensureFFprobe() {
  const { platform } = getPlatformArch();
  const binName = platform === "windows" ? "ffprobe.exe" : "ffprobe";
  const ffprobePath = path.join(TOOLS_DIR, "ffmpeg", platform, binName);

  if (fs.existsSync(ffprobePath)) return ffprobePath;

  console.log("[tools] FFprobe not found, would download from ffmpeg.org (TODO: implement actual download)");
  return null;
}

function ensureMediaMTX() {
  const { platform } = getPlatformArch();
  const binName = platform === "windows" ? "mediamtx.exe" : "mediamtx";
  const mtxPath = path.join(TOOLS_DIR, "mediamtx", platform, binName);

  if (fs.existsSync(mtxPath)) return mtxPath;

  console.log("[tools] MediaMTX not found, would download from bluenviron/mediamtx releases (TODO: implement actual download)");
  return null;
}

function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = [];
  const isWin = process.platform === "win32";

  if (isWin) {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(root, "Chromium", "Application", "chrome.exe")
      );
    }
  } else if (process.platform === "linux") {
    candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/snap/bin/chromium");
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  }

  return candidates.find(c => fs.existsSync(c)) || null;
}

module.exports = {
  TOOLS_DIR,
  getPlatformArch,
  downloadFile,
  ensureFFmpeg,
  ensureFFprobe,
  ensureMediaMTX,
  findChromium,
};
