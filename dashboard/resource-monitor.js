"use strict";

// Low-overhead resource diagnostics.
//
// CastNexus runs Chromium, several FFmpeg processes and the Node runtime side
// by side. When a VPS sits at 80% CPU the useful question is *which* of those
// is responsible, so components register the PIDs they own and this module
// turns /proc (Linux/Docker) CPU tick counters into per-component percentages.
//
// Sampling is cached: callers may ask as often as they like, but the process
// table is read at most once per MIN_SAMPLE_MS (default 2 s). Reading /proc is
// a handful of small file reads, far cheaper than spawning ps/top. On Windows
// (Electron / source installs) a single PowerShell CIM query is used, and only
// on demand, because spawning PowerShell is itself expensive.

const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const MIN_SAMPLE_MS = Math.max(500, Number(process.env.CASTNEXUS_MONITOR_INTERVAL_MS || 2000));
const CLK_TCK = 100; // Linux USER_HZ; effectively always 100 on x86_64/arm64.

const components = new Map(); // name -> { label, group, pids:()=>number[], tree:boolean, meta:()=>object }
let lastSample = null;
let previousTimes = null; // Map pid -> cpu seconds
let previousAt = 0;
let previousSystem = null;

function registerComponent(name, { label = name, group = "other", pids, tree = true, meta = null } = {}) {
  if (typeof pids !== "function") throw new TypeError("pids must be a function");
  components.set(String(name), { label, group, pids, tree, meta });
  return () => unregisterComponent(name);
}

function unregisterComponent(name) {
  components.delete(String(name));
}

function parseProcStat(text) {
  // pid (comm) state ppid ... utime(14) stime(15) ... rss(24)
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const pid = Number(text.slice(0, text.indexOf(" ")));
  const comm = text.slice(text.indexOf("(") + 1, close);
  const rest = text.slice(close + 2).split(" ");
  // rest[0] is field 3 (state), so field N is rest[N - 3].
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  return { pid, comm, ppid, cpuSeconds:(utime + stime) / CLK_TCK, rssBytes:rssPages * 4096 };
}

function readLinuxProcessTable() {
  const table = new Map();
  let entries;
  try { entries = fs.readdirSync("/proc"); } catch { return table; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const row = parseProcStat(fs.readFileSync(`/proc/${entry}/stat`, "utf8"));
      if (row) table.set(row.pid, row);
    } catch {}
  }
  return table;
}

function readWindowsProcessTable() {
  const table = new Map();
  const script = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$($_.KernelModeTime),$($_.UserModeTime),$($_.WorkingSetSize),$($_.Name)\" }";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding:"utf8", timeout:45000, windowsHide:true, maxBuffer:32 * 1024 * 1024 });
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    const [pid, ppid, kernel, user, ws, ...name] = line.split(",");
    if (!/^\d+$/.test(pid || "")) continue;
    table.set(Number(pid), {
      pid:Number(pid),
      ppid:Number(ppid),
      comm:name.join(","),
      // Win32_Process times are in 100 ns units.
      cpuSeconds:(Number(kernel || 0) + Number(user || 0)) / 1e7,
      rssBytes:Number(ws || 0),
    });
  }
  return table;
}

function readProcessTable(platform = process.platform) {
  if (platform === "linux") return readLinuxProcessTable();
  if (platform === "win32") return readWindowsProcessTable();
  return new Map();
}

function descendants(table, rootPids) {
  const children = new Map();
  for (const row of table.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const out = new Set();
  const stack = [...rootPids].filter(pid => table.has(pid));
  while (stack.length) {
    const pid = stack.pop();
    if (out.has(pid)) continue;
    out.add(pid);
    for (const child of children.get(pid) || []) stack.push(child);
  }
  return out;
}

function readSystemTimes() {
  let idle = 0, total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value;
      if (kind === "idle") idle += value;
    }
  }
  return { idle, total };
}

function systemSnapshot() {
  const now = readSystemTimes();
  let cpuPercent = null;
  if (previousSystem) {
    const total = now.total - previousSystem.total;
    const idle = now.idle - previousSystem.idle;
    cpuPercent = total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
  }
  previousSystem = now;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    cpuPercent:cpuPercent == null ? null : Math.round(cpuPercent * 10) / 10,
    cores:os.cpus().length,
    loadAverage:os.loadavg().map(v => Math.round(v * 100) / 100),
    ramUsedBytes:totalMem - freeMem,
    ramTotalBytes:totalMem,
    processRssBytes:process.memoryUsage().rss,
  };
}

// Pure helper (unit tested): convert two CPU-second readings into a percent of
// ONE core, which is how top/htop report per-process usage.
function cpuPercentBetween(beforeSeconds, afterSeconds, elapsedMs) {
  if (!(elapsedMs > 0)) return null;
  const delta = Math.max(0, Number(afterSeconds) - Number(beforeSeconds));
  return Math.round((delta / (elapsedMs / 1000)) * 1000) / 10;
}

// Spawning PowerShell costs far more than reading /proc, so Windows installs
// refresh the per-process table at most every 15 s.
function minIntervalFor(platform) {
  return platform === "win32" ? Math.max(15000, MIN_SAMPLE_MS) : MIN_SAMPLE_MS;
}

function sample({ force = false, platform = process.platform, table = null } = {}) {
  const at = Date.now();
  if (!force && lastSample && at - lastSample.at < minIntervalFor(platform)) return lastSample;
  const processes = table || readProcessTable(platform);
  const times = new Map([...processes.values()].map(row => [row.pid, row.cpuSeconds]));
  const elapsed = previousAt ? at - previousAt : 0;
  const result = [];
  for (const [name, component] of components) {
    let roots = [];
    try { roots = (component.pids() || []).map(Number).filter(pid => Number.isInteger(pid) && pid > 0); } catch {}
    const pids = component.tree ? descendants(processes, roots) : new Set(roots.filter(pid => processes.has(pid)));
    let cpu = 0, rss = 0, known = false;
    for (const pid of pids) {
      const row = processes.get(pid);
      if (!row) continue;
      rss += row.rssBytes;
      const before = previousTimes?.get(pid);
      if (before != null && elapsed > 0) {
        cpu += cpuPercentBetween(before, row.cpuSeconds, elapsed) || 0;
        known = true;
      }
    }
    let meta = null;
    try { meta = component.meta ? component.meta() : null; } catch {}
    result.push({
      name,
      label:component.label,
      group:component.group,
      processCount:pids.size,
      cpuPercent:known ? Math.round(cpu * 10) / 10 : null,
      rssBytes:rss,
      ...(meta ? { meta } : {}),
    });
  }
  previousTimes = times;
  previousAt = at;
  lastSample = {
    at,
    intervalMs:elapsed || null,
    supported:platform === "linux" || platform === "win32",
    system:systemSnapshot(),
    components:result,
  };
  return lastSample;
}

// Totals by group, e.g. every "music24" component or every "destination".
function groupTotals(snapshot = lastSample) {
  const out = {};
  for (const row of snapshot?.components || []) {
    const g = out[row.group] || (out[row.group] = { cpuPercent:0, rssBytes:0, components:0, measured:false });
    g.components++;
    g.rssBytes += row.rssBytes || 0;
    if (row.cpuPercent != null) { g.cpuPercent = Math.round((g.cpuPercent + row.cpuPercent) * 10) / 10; g.measured = true; }
  }
  return out;
}

// One-shot measurement of an arbitrary process tree across a window. Used by
// tools/music24-benchmark.js so before/after runs use the same arithmetic.
async function measureTree(rootPid, durationMs, { platform = process.platform, classify = null } = {}) {
  const t0 = readProcessTable(platform);
  const started = Date.now();
  await new Promise(resolve => setTimeout(resolve, durationMs));
  const t1 = readProcessTable(platform);
  const elapsed = Date.now() - started;
  const pids = descendants(t1, [rootPid]);
  const byClass = {};
  for (const pid of pids) {
    if (pid === rootPid) continue;
    const after = t1.get(pid), before = t0.get(pid);
    const cls = classify ? classify(after) : after.comm;
    const bucket = byClass[cls] || (byClass[cls] = { cpuPercent:0, rssBytes:0, processes:0 });
    bucket.processes++;
    bucket.rssBytes += after.rssBytes;
    bucket.cpuPercent += cpuPercentBetween(before ? before.cpuSeconds : after.cpuSeconds, after.cpuSeconds, elapsed) || 0;
  }
  const self = t1.get(rootPid), selfBefore = t0.get(rootPid);
  if (self) byClass.node = { cpuPercent:cpuPercentBetween(selfBefore?.cpuSeconds ?? self.cpuSeconds, self.cpuSeconds, elapsed), rssBytes:self.rssBytes, processes:1 };
  for (const bucket of Object.values(byClass)) bucket.cpuPercent = Math.round(bucket.cpuPercent * 10) / 10;
  const totalCpu = Math.round(Object.values(byClass).reduce((sum, b) => sum + (b.cpuPercent || 0), 0) * 10) / 10;
  const totalRss = Object.values(byClass).reduce((sum, b) => sum + (b.rssBytes || 0), 0);
  return { elapsedMs:elapsed, cores:os.cpus().length, totalCpuPercentOfOneCore:totalCpu, totalRssBytes:totalRss, byClass };
}

module.exports = {
  MIN_SAMPLE_MS,
  registerComponent,
  unregisterComponent,
  parseProcStat,
  readProcessTable,
  descendants,
  cpuPercentBetween,
  sample,
  groupTotals,
  measureTree,
  _components:components,
};
