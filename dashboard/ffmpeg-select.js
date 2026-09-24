"use strict";

// Chooses which FFmpeg build CastNexus uses, before any module spawns one.
//
// The Docker image ships two builds: Debian's system FFmpeg (5.1 on bookworm)
// at /usr/bin and a static FFmpeg 8 at /opt/ffmpeg/bin. CASTNEXUS_FFMPEG picks:
//   auto     (default) benchmark every available build once, use the fastest
//            (cached in data/ffmpeg-choice.json until the builds change)
//   bundled  the image's FFmpeg 8
//   system   the distro FFmpeg (e.g. 5.1) - the old behaviour
//   <path>   a specific ffmpeg binary or the folder that contains it
// The choice is applied by prepending its folder to PATH and setting
// FFMPEG_BIN / FFPROBE_BIN, so every spawn("ffmpeg"/"ffprobe") follows it.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "data", "state.json");
const CACHE_FILE = process.env.CASTNEXUS_FFMPEG_CHOICE_FILE || path.join(path.dirname(STATE_FILE), "ffmpeg-choice.json");
const BUNDLED_DIR = process.env.CASTNEXUS_FFMPEG_BUNDLED_DIR || "/opt/ffmpeg/bin";
const EXE = process.platform === "win32" ? ".exe" : "";

let selection = null;

function versionOf(bin) {
  try {
    const r = spawnSync(bin, ["-hide_banner", "-version"], { encoding:"utf8", timeout:8000 });
    const line = String(r.stdout || "").split(/\r?\n/)[0] || "";
    const m = /ffmpeg version\s+(\S+)/i.exec(line);
    return r.status === 0 && m ? m[1] : null;
  } catch { return null; }
}

function whichFfmpeg() {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, `ffmpeg${EXE}`);
    if (path.resolve(dir) === path.resolve(BUNDLED_DIR)) continue;
    try { if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

function candidateFromPath(value, id) {
  let file = value;
  try { if (fs.statSync(value).isDirectory()) file = path.join(value, `ffmpeg${EXE}`); } catch { return null; }
  const version = versionOf(file);
  return version ? { id, bin:file, dir:path.dirname(file), version } : null;
}

function candidates() {
  const out = [];
  const bundled = candidateFromPath(path.join(BUNDLED_DIR, `ffmpeg${EXE}`), "bundled");
  if (bundled) out.push(bundled);
  const sys = whichFfmpeg();
  const system = sys ? candidateFromPath(sys, "system") : null;
  if (system && !out.some(c => c.version === system.version && c.bin === system.bin)) out.push(system);
  return out;
}

// Live-program-like workload: 720p30 gameplay + RGBA overlay + audio, x264.
function benchmark(candidate, frames = Number(process.env.CASTNEXUS_FFMPEG_BENCH_FRAMES || 150)) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30",
    "-f", "lavfi", "-i", "color=c=black@0:s=1280x720:r=15,format=rgba",
    "-f", "lavfi", "-i", "sine=f=440:r=48000",
    "-filter_complex", "[0:v][1:v]overlay=0:0:eof_action=repeat,format=yuv420p[v];[2:a]aresample=48000,aformat=channel_layouts=stereo[a]",
    "-map", "[v]", "-map", "[a]", "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-threads", "2",
    "-c:a", "aac", "-b:a", "128k", "-f", "null", "-"];
  let best = null;
  for (let run = 0; run < 2; run++) {
    const started = process.hrtime.bigint();
    const r = spawnSync(candidate.bin, args, { encoding:"utf8", timeout:120000 });
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    if (r.status !== 0) return { ok:false, error:String(r.stderr || r.error?.message || "failed").trim().split(/\r?\n/).slice(-1)[0] };
    const fps = Math.round(frames / seconds * 10) / 10;
    if (!best || fps > best.fps) best = { ok:true, fps, seconds:Math.round(seconds * 100) / 100 };
  }
  return best;
}

function major(version) {
  const m = /^n?(\d+)\./.exec(String(version || ""));
  if (m) return Number(m[1]);
  return /^(N-|\d{4}-\d{2}-\d{2})/.test(String(version || "")) ? 99 : 0;
}

function readCache(key) {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return cached?.key === key ? cached : null;
  } catch { return null; }
}

function writeCache(value) {
  try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive:true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(value, null, 2)); } catch {}
}

function choose({ mode = process.env.CASTNEXUS_FFMPEG || "auto", logger = console, force = false } = {}) {
  const wanted = String(mode || "auto").trim();
  const list = candidates();
  const result = { mode:wanted, chosen:null, candidates:list.map(c => ({ id:c.id, version:c.version, bin:c.bin })), results:null, reason:"", at:new Date().toISOString() };

  if (!/^(auto|bundled|system)$/i.test(wanted)) {
    const custom = candidateFromPath(wanted, "custom");
    if (custom) { result.chosen = custom; result.reason = "CASTNEXUS_FFMPEG path"; return result; }
    result.reason = `CASTNEXUS_FFMPEG=${wanted} is not a working ffmpeg; using auto`;
  }
  const byId = id => list.find(c => c.id === id) || null;
  if (/^bundled$/i.test(wanted) || /^system$/i.test(wanted)) {
    const pick = byId(wanted.toLowerCase());
    if (pick) { result.chosen = pick; result.reason = `CASTNEXUS_FFMPEG=${wanted.toLowerCase()}`; return result; }
    result.reason = `no ${wanted.toLowerCase()} FFmpeg in this install; using auto`;
  }
  if (list.length <= 1) { result.chosen = list[0] || null; result.reason ||= list.length ? "only one FFmpeg available" : "no FFmpeg found"; return result; }

  const key = list.map(c => `${c.id}:${c.bin}:${c.version}`).join("|");
  const cached = !force && readCache(key);
  if (cached?.chosenId) {
    const pick = byId(cached.chosenId);
    if (pick) { result.chosen = pick; result.results = cached.results; result.reason = `benchmark ${cached.at} (saved)`; return result; }
  }
  logger.log?.(`[ffmpeg] benchmarking ${list.map(c => `${c.id} ${c.version}`).join(" vs ")} (one time, a few seconds)...`);
  const results = list.map(c => ({ id:c.id, version:c.version, ...benchmark(c) }));
  const working = results.filter(r => r.ok);
  // Prefer the newer build unless the older one is clearly (>10%) faster:
  // FFmpeg 7+ also schedules live multi-input graphs better than 5.x/6.x.
  working.sort((a, b) => b.fps - a.fps);
  let winner = working[0] || null;
  if (winner) {
    const newest = [...working].sort((a, b) => major(b.version) - major(a.version))[0];
    if (newest !== winner && newest.fps >= winner.fps * 0.9) winner = newest;
  }
  result.results = results;
  result.chosen = winner ? byId(winner.id) : list[0];
  result.reason = winner ? `benchmark: ${results.map(r => `${r.id} ${r.version} ${r.ok ? `${r.fps} fps` : `failed (${r.error})`}`).join(", ")}` : "benchmark failed; using the first build";
  writeCache({ key, chosenId:result.chosen?.id || null, results, at:result.at });
  return result;
}

function apply(options = {}) {
  const logger = options.logger || console;
  if (process.env.FFMPEG_BIN && !process.env.CASTNEXUS_FFMPEG) {
    selection = { mode:"FFMPEG_BIN", chosen:{ id:"custom", bin:process.env.FFMPEG_BIN, version:versionOf(process.env.FFMPEG_BIN) }, reason:"FFMPEG_BIN is set" };
    return selection;
  }
  try { selection = choose({ ...options, logger }); }
  catch (error) { selection = { mode:"auto", chosen:null, reason:`selection failed: ${error.message}` }; }
  const chosen = selection.chosen;
  if (chosen?.dir) {
    process.env.PATH = [chosen.dir, ...String(process.env.PATH || "").split(path.delimiter).filter(dir => path.resolve(dir) !== path.resolve(chosen.dir))].join(path.delimiter);
    process.env.FFMPEG_BIN = chosen.bin;
    const probe = path.join(chosen.dir, `ffprobe${EXE}`);
    if (fs.existsSync(probe)) process.env.FFPROBE_BIN = probe;
    logger.log?.(`[ffmpeg] using ${chosen.id} FFmpeg ${chosen.version} (${chosen.bin}) - ${selection.reason}`);
  }
  return selection;
}

function status() {
  return selection ? { mode:selection.mode, id:selection.chosen?.id || null, version:selection.chosen?.version || null, bin:selection.chosen?.bin || null, reason:selection.reason, candidates:selection.candidates || [], results:selection.results || null } : null;
}

function clearCache() { try { fs.unlinkSync(CACHE_FILE); } catch {} }

module.exports = { apply, choose, status, candidates, benchmark, clearCache, major };
