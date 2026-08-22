"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const { createWriteStream, promises: fsPromises } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { execSync } = require("node:child_process");

// In packaged app, tools are downloaded to user's home directory (writable)
// In dev, they're in ../tools relative to electron directory
const TOOLS_DIR = process.env.NODE_ENV === 'development'
  ? path.join(__dirname, '../tools')
  : path.join(os.homedir(), '.castnexus', 'tools');

function getPlatformArch() {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "x86";
  return { platform, arch };
}

async function extractArchive(archivePath, extractDir) {
  const ext = path.extname(archivePath).toLowerCase();

  try {
    if (ext === '.zip') {
      // Use built-in Windows unzip or Node modules
      if (process.platform === 'win32') {
        // PowerShell unzip for Windows
        execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'inherit' });
      } else {
        // Use unzip command on Unix
        execSync(`unzip -o "${archivePath}" -d "${extractDir}"`, { stdio: 'inherit' });
      }
    } else if (ext === '.gz') {
      // tar.gz extraction
      execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, { stdio: 'inherit' });
    }

    console.log(`[tools] Extracted ${archivePath} to ${extractDir}`);
    // Delete archive after extraction
    fs.unlinkSync(archivePath);
  } catch (err) {
    console.error(`[tools] Extraction failed:`, err.message);
    throw err;
  }
}

async function downloadFile(url, outputPath, onProgress, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    const attemptDownload = (downloadUrl, redirectsRemaining) => {
      const file = createWriteStream(outputPath);

      https.get(downloadUrl, res => {
        // Handle redirects (3xx status codes)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.destroy();
          if (redirectsRemaining <= 0) {
            return reject(new Error(`Download failed: Too many redirects`));
          }
          // Follow redirect
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, downloadUrl).toString();
          return attemptDownload(redirectUrl, redirectsRemaining - 1);
        }

        if (res.statusCode !== 200) {
          file.destroy();
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }

        const totalSize = parseInt(res.headers['content-length'], 10);
        let downloadedSize = 0;

        res.on('data', chunk => {
          downloadedSize += chunk.length;
          if (onProgress && totalSize) {
            onProgress({ downloaded: downloadedSize, total: totalSize });
          }
        });

        pipeline(res, file).then(resolve).catch(reject);
      }).on("error", reject);
    };

    attemptDownload(url, maxRedirects);
  });
}

async function ensureFFmpeg(onProgress) {
  const { platform, arch } = getPlatformArch();
  const binName = platform === "windows" ? "ffmpeg.exe" : "ffmpeg";
  const ffmpegPath = path.join(TOOLS_DIR, "ffmpeg", platform, binName);

  if (fs.existsSync(ffmpegPath)) return ffmpegPath;

  try {
    console.log("[tools] Downloading FFmpeg...");
    const ffmpegVersion = "7.1";
    let downloadUrl;

    if (platform === "windows") {
      downloadUrl = `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2024-12-31-12-40/ffmpeg-N-121887-g${arch === 'x64' ? 'g63f670f' : 'g63f670f'}-win${arch === 'x64' ? '64' : '32'}-gpl.zip`;
    } else if (platform === "linux") {
      downloadUrl = `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2024-12-31-12-40/ffmpeg-N-121887-g63f670f-linux${arch}-gpl.tar.xz`;
    } else if (platform === "macos") {
      downloadUrl = `https://evermeet.cx/ffmpeg/getrelease/zip`;
    }

    if (!downloadUrl) throw new Error(`Unsupported platform: ${platform}`);

    const zipPath = path.join(TOOLS_DIR, "ffmpeg", `ffmpeg-${platform}.zip`);
    await downloadFile(downloadUrl, zipPath, onProgress);
    console.log("[tools] FFmpeg downloaded successfully");
    return ffmpegPath;
  } catch (err) {
    console.error("[tools] FFmpeg download failed:", err.message);
    return null;
  }
}

async function ensureFFprobe(onProgress) {
  const { platform } = getPlatformArch();
  const binName = platform === "windows" ? "ffprobe.exe" : "ffprobe";
  const ffprobePath = path.join(TOOLS_DIR, "ffmpeg", platform, binName);

  if (fs.existsSync(ffprobePath)) return ffprobePath;
  // ffprobe comes with ffmpeg, so ensure ffmpeg is downloaded first
  return await ensureFFmpeg(onProgress);
}

async function ensureMediaMTX(onProgress) {
  const { platform, arch } = getPlatformArch();
  const binName = platform === "windows" ? "mediamtx.exe" : "mediamtx";
  const mtxPath = path.join(TOOLS_DIR, "mediamtx", binName);

  if (fs.existsSync(mtxPath)) return mtxPath;

  try {
    console.log("[tools] Downloading MediaMTX...");
    const mtxVersion = "v1.19.2";
    let downloadUrl;

    // Map arch names: x64 -> amd64, arm64 -> arm64
    const archMap = { x64: "amd64", x86: "386", arm64: "arm64v8" };
    const mappedArch = archMap[arch] || arch;

    if (platform === "windows") {
      downloadUrl = `https://github.com/bluenviron/mediamtx/releases/download/${mtxVersion}/mediamtx_${mtxVersion}_windows_${mappedArch}.zip`;
    } else if (platform === "linux") {
      downloadUrl = `https://github.com/bluenviron/mediamtx/releases/download/${mtxVersion}/mediamtx_${mtxVersion}_linux_${mappedArch}.tar.gz`;
    } else if (platform === "macos") {
      downloadUrl = `https://github.com/bluenviron/mediamtx/releases/download/${mtxVersion}/mediamtx_${mtxVersion}_darwin_${mappedArch}.tar.gz`;
    }

    if (!downloadUrl) throw new Error(`Unsupported platform: ${platform}`);

    const archivePath = platform === "windows"
      ? path.join(TOOLS_DIR, "mediamtx", `mediamtx.zip`)
      : path.join(TOOLS_DIR, "mediamtx", `mediamtx.tar.gz`);

    await downloadFile(downloadUrl, archivePath, onProgress);
    console.log("[tools] MediaMTX downloaded successfully");

    // Extract the archive
    const extractDir = path.join(TOOLS_DIR, "mediamtx");
    await extractArchive(archivePath, extractDir);

    return mtxPath;
  } catch (err) {
    console.error("[tools] MediaMTX download failed:", err.message);
    return null;
  }
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
  async ensureAllTools(onProgress) {
    const results = {};
    const tools = ['MediaMTX', 'FFmpeg', 'FFprobe'];

    for (const tool of tools) {
      onProgress?.({ status: `Checking ${tool}...` });
      if (tool === 'MediaMTX') {
        results.mediamtx = await ensureMediaMTX(onProgress);
      } else if (tool === 'FFmpeg') {
        results.ffmpeg = await ensureFFmpeg(onProgress);
      } else if (tool === 'FFprobe') {
        results.ffprobe = await ensureFFprobe(onProgress);
      }
    }

    return results;
  }
};
