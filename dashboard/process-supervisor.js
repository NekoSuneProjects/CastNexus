"use strict";

// Supervised FFmpeg worker: restart with exponential backoff, classify
// failures from stderr, expose health, and never leave zombie processes.
//
// Used for destination pushes and shared renditions. The previous code
// restarted every 2 s forever, so a revoked stream key or unreachable ingest
// produced a new FFmpeg process every two seconds with no visible reason.

const { spawn } = require("node:child_process");

const MIN_BACKOFF_MS = Number(process.env.DESTINATION_RESTART_MIN_MS || 2000);
const MAX_BACKOFF_MS = Number(process.env.DESTINATION_RESTART_MAX_MS || 60000);
// A process that stayed up this long is considered healthy again.
const STABLE_MS = Number(process.env.DESTINATION_STABLE_MS || 30000);
const KILL_GRACE_MS = 4000;

const FAILURE_PATTERNS = [
  ["broken-pipe", /broken pipe|EPIPE/i],
  ["connection-refused", /connection refused|ECONNREFUSED/i],
  ["connection-reset", /connection reset|ECONNRESET|end of file|error writing trailer|Input\/output error/i],
  ["auth-rejected", /401|403|unauthori[sz]ed|forbidden|invalid (stream )?key|NetStream\.Publish\.BadName|publish.*(denied|rejected)/i],
  ["dns", /(could not|failed to) resolve|name or service not known|getaddrinfo/i],
  ["timeout", /timed? ?out|ETIMEDOUT/i],
  ["source-missing", /404|not found|no such stream|stream not found/i],
  ["encoder", /(nvenc|qsv|vaapi|amf|libx264).*(error|fail)|cannot load|no capable devices|device creation failed|driver/i],
];

function classifyFailure(text) {
  for (const [kind, pattern] of FAILURE_PATTERNS) if (pattern.test(String(text || ""))) return kind;
  return text ? "ffmpeg-error" : null;
}

function nextBackoff(previousMs, uptimeMs, { min = MIN_BACKOFF_MS, max = MAX_BACKOFF_MS, stable = STABLE_MS } = {}) {
  if (uptimeMs >= stable || !previousMs) return min;
  return Math.min(max, Math.max(min, previousMs * 2));
}

function killHard(child, graceMs = KILL_GRACE_MS) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  try { child.kill("SIGTERM"); } catch {}
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, graceMs);
  timer.unref?.();
  child.once("exit", () => clearTimeout(timer));
}

class SupervisedProcess {
  // build() -> { cmd, args } is called on every (re)start so the latest
  // encoder/fallback/destination settings are always used.
  constructor({ name, build, shouldRun = () => true, onExit = null, logger = console, bin = process.env.FFMPEG_BIN || "ffmpeg" }) {
    this.name = name;
    this.build = build;
    this.shouldRun = shouldRun;
    this.onExit = onExit;
    this.logger = logger;
    this.bin = bin;
    this.child = null;
    this.timer = null;
    this.stopped = true;
    this.backoffMs = 0;
    this.restarts = 0;
    this.startedAt = null;
    this.lastExit = null;
    this.lastError = null;
    this.lastErrorKind = null;
    this.stderrTail = [];
    this.state = "idle";
  }

  start() {
    this.stopped = false;
    if (this.child || this.timer) return;
    this._spawn();
  }

  _spawn() {
    this.timer = null;
    if (this.stopped || !this.shouldRun()) { this.state = "idle"; return; }
    let spec;
    try { spec = this.build(); } catch (error) { this.lastError = error.message; this.lastErrorKind = "config"; this.state = "error"; return; }
    if (!spec) { this.state = "idle"; return; }
    // The input is not published yet (e.g. a program compositor still
    // starting): look again shortly, without counting it as a failure.
    if (spec.wait) {
      this.state = "waiting";
      this.waitReason = spec.reason || "waiting for input";
      this.timer = setTimeout(() => this._spawn(), Number(spec.retryMs) || 1500);
      this.timer.unref?.();
      return;
    }
    this.waitReason = null;
    this.stderrTail = [];
    const child = spawn(spec.cmd || this.bin, spec.args, { stdio:["ignore", "ignore", "pipe"] });
    this.child = child;
    this.startedAt = Date.now();
    this.state = "starting";
    child.stderr.on("data", chunk => {
      const lines = chunk.toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!lines.length) return;
      this.stderrTail.push(...lines);
      if (this.stderrTail.length > 20) this.stderrTail.splice(0, this.stderrTail.length - 20);
      const bad = lines.filter(line => /error|fail|refused|denied|broken|reset|invalid|not found|unauthori|forbidden|timed out/i.test(line));
      if (bad.length) { this.lastError = bad.at(-1).slice(0, 300); this.lastErrorKind = classifyFailure(bad.join("\n")); }
    });
    // FFmpeg that keeps running for a few seconds is publishing.
    const liveTimer = setTimeout(() => { if (this.child === child) this.state = "live"; }, 4000);
    liveTimer.unref?.();
    child.on("error", error => { this.lastError = error.message; this.lastErrorKind = "spawn"; });
    child.on("exit", (code, signal) => {
      clearTimeout(liveTimer);
      if (this.child !== child) return;
      this.child = null;
      const uptime = Date.now() - (this.startedAt || Date.now());
      this.lastExit = { code, signal, uptimeMs:uptime, at:new Date().toISOString() };
      if (code !== 0 && !this.lastErrorKind) this.lastErrorKind = classifyFailure(this.stderrTail.join("\n"));
      let handled = false;
      try { handled = this.onExit?.({ code, signal, uptimeMs:uptime, errorKind:this.lastErrorKind, stderr:this.stderrTail.slice() }) === "handled"; } catch {}
      if (this.stopped || handled || !this.shouldRun()) { this.state = this.stopped ? "idle" : this.state; return; }
      this.backoffMs = nextBackoff(this.backoffMs, uptime);
      this.restarts++;
      this.state = "reconnecting";
      if (code !== 0) this.logger.warn?.(`[supervisor] ${this.name} exited (code ${code}${this.lastErrorKind ? `, ${this.lastErrorKind}` : ""}); retry in ${Math.round(this.backoffMs / 1000)}s`);
      this.timer = setTimeout(() => this._spawn(), this.backoffMs);
      this.timer.unref?.();
    });
  }

  // Restart immediately (e.g. after an encoder fallback) without backoff.
  restartNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const child = this.child;
    this.child = null;
    if (child) { child.removeAllListeners("exit"); killHard(child); }
    this.backoffMs = 0;
    if (!this.stopped) this._spawn();
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const child = this.child;
    this.child = null;
    if (child) { child.removeAllListeners("exit"); killHard(child); }
    this.state = "idle";
  }

  pid() { return this.child?.pid || null; }

  status() {
    return {
      state:this.state,
      pid:this.pid(),
      restarts:this.restarts,
      uptimeMs:this.child && this.startedAt ? Date.now() - this.startedAt : 0,
      nextRetryMs:this.timer ? this.backoffMs : null,
      waitReason:this.state === "waiting" ? this.waitReason : null,
      lastError:this.lastError,
      lastErrorKind:this.lastErrorKind,
      lastExit:this.lastExit,
    };
  }
}

module.exports = { SupervisedProcess, classifyFailure, nextBackoff, killHard, MIN_BACKOFF_MS, MAX_BACKOFF_MS, STABLE_MS };
