"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const { createWriteStream } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { execFileSync } = require("node:child_process");

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

// A zero-byte or tiny file is a failed download, not an installed tool.
// Without this check a single failed download permanently "installs" a broken
// binary that is never retried.
function hasUsableBinary(binPath) {
  try {
    const st = fs.statSync(binPath);
    return st.isFile() && st.size > 1024;
  } catch {
    return false;
  }
}

function rmQuiet(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

// Archives usually contain a nested folder (ffmpeg-*/bin/ffmpeg.exe,
// mediamtx_*/mediamtx). Locate the binary wherever it landed.
function findFileRecursive(dir, fileName, depth = 0) {
  if (depth > 5) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFileRecursive(path.join(dir, entry.name), fileName, depth + 1);
    if (found) return found;
  }
  return null;
}

// Move an extracted binary out of its nested folder to the path we expect.
function promoteBinary(extractDir, binName, targetPath) {
  if (hasUsableBinary(targetPath)) return targetPath;
  const found = findFileRecursive(extractDir, binName);
  if (!found) return null;
  if (path.resolve(found) === path.resolve(targetPath)) return targetPath;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(found, targetPath);
  return hasUsableBinary(targetPath) ? targetPath : null;
}

async function extractArchive(archivePath, extractDir) {
  const lower = archivePath.toLowerCase();

  fs.mkdirSync(extractDir, { recursive: true });

  try {
    if (lower.endsWith('.zip')) {
      try {
        const extractZip = require('extract-zip');
        await extractZip(archivePath, { dir: path.resolve(extractDir) });
      } catch (nodeErr) {
        console.log('[tools] extract-zip unavailable, using system extractor...');
        if (process.platform === 'win32') {
          // Pass args as an array so paths with spaces/quotes can't break out.
          execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(extractDir)} -Force`,
          ], { stdio: 'inherit' });
        } else {
          execFileSync('unzip', ['-o', archivePath, '-d', extractDir], { stdio: 'inherit' });
        }
      }
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar.xz') || lower.endsWith('.gz') || lower.endsWith('.xz')) {
      // bsdtar (bundled with Windows 10+) and GNU tar both auto-detect gz/xz with -xf
      execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' });
    } else {
      throw new Error(`Unknown archive type: ${archivePath}`);
    }

    console.log(`[tools] Extracted ${path.basename(archivePath)} -> ${extractDir}`);
  } catch (err) {
    console.error(`[tools] Extraction failed:`, err.message);
    throw err;
  } finally {
    rmQuiet(archivePath);
  }
}

/**
 * Download to a .part file and rename only on success, so an interrupted or
 * failed download never leaves a file that later looks like an installed tool.
 */
async function downloadFile(url, outputPath, onProgress, maxRedirects = 5) {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${outputPath}.part`;
  rmQuiet(tmpPath);

  const response = await new Promise((resolve, reject) => {
    const attempt = (downloadUrl, redirectsRemaining) => {
      const req = https.get(downloadUrl, {
        headers: { 'User-Agent': 'CastNexus-Desktop' },
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // drain so the socket can be reused/closed
          if (redirectsRemaining <= 0) return reject(new Error('Too many redirects'));
          const next = new URL(res.headers.location, downloadUrl).toString();
          return attempt(next, redirectsRemaining - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${downloadUrl}`));
        }
        resolve(res);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('Download timed out')));
    };
    attempt(url, maxRedirects);
  });

  try {
    const totalSize = Number.parseInt(response.headers['content-length'], 10) || 0;
    let downloaded = 0;
    response.on('data', chunk => {
      downloaded += chunk.length;
      if (onProgress && totalSize) onProgress({ downloaded, total: totalSize });
    });

    await pipeline(response, createWriteStream(tmpPath));

    if (!hasUsableBinary(tmpPath)) {
      throw new Error('Downloaded file is empty or truncated');
    }

    rmQuiet(outputPath);
    fs.renameSync(tmpPath, outputPath);
    return outputPath;
  } catch (err) {
    rmQuiet(tmpPath);
    throw err;
  }
}

function chmodExec(binPath) {
  if (process.platform === 'win32') return;
  try { fs.chmodSync(binPath, 0o755); } catch {}
}

async function ensureFFmpeg(onProgress) {
  const { platform, arch } = getPlatformArch();
  const binName = platform === "windows" ? "ffmpeg.exe" : "ffmpeg";
  const destDir = path.join(TOOLS_DIR, "ffmpeg", platform);
  const ffmpegPath = path.join(destDir, binName);

  if (hasUsableBinary(ffmpegPath)) return ffmpegPath;

  try {
    console.log("[tools] Downloading FFmpeg...");
    let downloadUrl;
    let archiveName;

    // BtbN publishes a rolling "latest" tag with these exact asset names.
    if (platform === "windows") {
      archiveName = arch === "arm64" ? "ffmpeg-master-latest-winarm64-gpl.zip" : "ffmpeg-master-latest-win64-gpl.zip";
      downloadUrl = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${archiveName}`;
    } else if (platform === "linux") {
      archiveName = arch === "arm64" ? "ffmpeg-master-latest-linuxarm64-gpl.tar.xz" : "ffmpeg-master-latest-linux64-gpl.tar.xz";
      downloadUrl = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${archiveName}`;
    } else {
      archiveName = "ffmpeg-macos.zip";
      downloadUrl = "https://evermeet.cx/ffmpeg/getrelease/zip";
    }

    const archivePath = path.join(destDir, archiveName);
    await downloadFile(downloadUrl, archivePath, onProgress);
    await extractArchive(archivePath, destDir);

    const resolved = promoteBinary(destDir, binName, ffmpegPath);
    if (!resolved) throw new Error("ffmpeg binary not found in archive");
    chmodExec(resolved);

    // ffprobe ships in the same archive — promote it too while we're here.
    const probeName = platform === "windows" ? "ffprobe.exe" : "ffprobe";
    const probePath = path.join(destDir, probeName);
    const probe = promoteBinary(destDir, probeName, probePath);
    if (probe) chmodExec(probe);

    console.log("[tools] FFmpeg ready:", resolved);
    return resolved;
  } catch (err) {
    console.error("[tools] FFmpeg download failed:", err.message);
    return null;
  }
}

async function ensureFFprobe(onProgress) {
  const { platform } = getPlatformArch();
  const binName = platform === "windows" ? "ffprobe.exe" : "ffprobe";
  const ffprobePath = path.join(TOOLS_DIR, "ffmpeg", platform, binName);

  if (hasUsableBinary(ffprobePath)) return ffprobePath;

  // ffprobe ships inside the ffmpeg archive.
  await ensureFFmpeg(onProgress);
  return hasUsableBinary(ffprobePath) ? ffprobePath : null;
}

async function ensureMediaMTX(onProgress) {
  const { platform, arch } = getPlatformArch();
  const binName = platform === "windows" ? "mediamtx.exe" : "mediamtx";
  const destDir = path.join(TOOLS_DIR, "mediamtx");
  const mtxPath = path.join(destDir, binName);

  if (hasUsableBinary(mtxPath)) return mtxPath;

  try {
    console.log("[tools] Downloading MediaMTX...");
    const mtxVersion = "v1.19.2";
    const archMap = { x64: "amd64", x86: "386", arm64: "arm64v8" };
    const mappedArch = archMap[arch] || arch;

    let downloadUrl;
    let archiveName;
    if (platform === "windows") {
      archiveName = `mediamtx_${mtxVersion}_windows_${mappedArch}.zip`;
    } else if (platform === "linux") {
      archiveName = `mediamtx_${mtxVersion}_linux_${mappedArch}.tar.gz`;
    } else {
      archiveName = `mediamtx_${mtxVersion}_darwin_${mappedArch}.tar.gz`;
    }
    downloadUrl = `https://github.com/bluenviron/mediamtx/releases/download/${mtxVersion}/${archiveName}`;

    const archivePath = path.join(destDir, archiveName);
    await downloadFile(downloadUrl, archivePath, onProgress);
    await extractArchive(archivePath, destDir);

    const resolved = promoteBinary(destDir, binName, mtxPath);
    if (!resolved) throw new Error("mediamtx binary not found in archive");
    chmodExec(resolved);

    console.log("[tools] MediaMTX ready:", resolved);
    return resolved;
  } catch (err) {
    console.error("[tools] MediaMTX download failed:", err.message);
    return null;
  }
}

async function ensureYtDlp(onProgress) {
  const { platform, arch } = getPlatformArch();
  const binName = platform === "windows" ? "yt-dlp.exe" : "yt-dlp";
  const ytDlpPath = path.join(TOOLS_DIR, "yt-dlp", binName);

  if (hasUsableBinary(ytDlpPath)) return ytDlpPath;

  try {
    console.log("[tools] Downloading yt-dlp (nightly)...");

    // Nightly builds live in a separate repo. Use GitHub's /releases/latest/download/
    // redirect — the nightly repo tags by date, so there is no literal "latest" tag.
    const base = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download";
    let asset;
    if (platform === "windows") {
      asset = "yt-dlp.exe";
    } else if (platform === "linux") {
      asset = "yt-dlp";
    } else {
      asset = arch === "arm64" ? "yt-dlp_macos" : "yt-dlp_macos_legacy";
    }

    await downloadFile(`${base}/${asset}`, ytDlpPath, onProgress);
    chmodExec(ytDlpPath);

    console.log("[tools] yt-dlp (nightly) ready:", ytDlpPath);
    return ytDlpPath;
  } catch (err) {
    console.error("[tools] yt-dlp download failed:", err.message);
    return null;
  }
}

async function ensureDeno(onProgress) {
  const { platform, arch } = getPlatformArch();
  const binName = platform === "windows" ? "deno.exe" : "deno";
  const destDir = path.join(TOOLS_DIR, "deno");
  const denoPath = path.join(destDir, binName);

  if (hasUsableBinary(denoPath)) return denoPath;

  try {
    console.log("[tools] Downloading Deno...");
    const denoVersion = "v1.45.0";

    let target;
    if (platform === "windows") {
      target = "x86_64-pc-windows-msvc";
    } else if (platform === "linux") {
      target = arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
    } else {
      target = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    }

    const archiveName = `deno-${target}.zip`;
    const downloadUrl = `https://github.com/denoland/deno/releases/download/${denoVersion}/${archiveName}`;
    const archivePath = path.join(destDir, archiveName);

    await downloadFile(downloadUrl, archivePath, onProgress);
    await extractArchive(archivePath, destDir);

    const resolved = promoteBinary(destDir, binName, denoPath);
    if (!resolved) throw new Error("deno binary not found in archive");
    chmodExec(resolved);

    console.log("[tools] Deno ready:", resolved);
    return resolved;
  } catch (err) {
    console.error("[tools] Deno download failed:", err.message);
    return null;
  }
}

// Paths the tools *should* live at, without triggering a download.
function getToolPaths() {
  const { platform } = getPlatformArch();
  const exe = (name) => (platform === "windows" ? `${name}.exe` : name);
  return {
    mediamtx: path.join(TOOLS_DIR, "mediamtx", exe("mediamtx")),
    ffmpeg: path.join(TOOLS_DIR, "ffmpeg", platform, exe("ffmpeg")),
    ffprobe: path.join(TOOLS_DIR, "ffmpeg", platform, exe("ffprobe")),
    ytdlp: path.join(TOOLS_DIR, "yt-dlp", exe("yt-dlp")),
    deno: path.join(TOOLS_DIR, "deno", exe("deno")),
  };
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
  getToolPaths,
  hasUsableBinary,
  downloadFile,
  extractArchive,
  ensureFFmpeg,
  ensureFFprobe,
  ensureMediaMTX,
  ensureYtDlp,
  ensureDeno,
  findChromium,
  async ensureAllTools(onProgress) {
    const results = {};
    onProgress?.({ status: "Checking MediaMTX..." });
    results.mediamtx = await ensureMediaMTX(onProgress);
    onProgress?.({ status: "Checking FFmpeg..." });
    results.ffmpeg = await ensureFFmpeg(onProgress);
    onProgress?.({ status: "Checking FFprobe..." });
    results.ffprobe = await ensureFFprobe(onProgress);
    onProgress?.({ status: "Checking yt-dlp..." });
    results.ytdlp = await ensureYtDlp(onProgress);
    onProgress?.({ status: "Checking Deno..." });
    results.deno = await ensureDeno(onProgress);
    return results;
  }
};
