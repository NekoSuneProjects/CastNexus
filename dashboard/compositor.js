"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const puppeteer = require("puppeteer-core");

/**
 * Optional per-account "built-in compositor" - the same mechanism
 * CacheStream uses (github.com/NekoSuneProjectsForks/NekoStreamAPP, `docker`
 * branch, apps/streamer/src/stream.js), adapted for a project whose video is
 * a REAL external feed rather than 100% browser-rendered content:
 *
 *   Headless Chromium (CDP Page.startScreencast, JPEG frames)
 *   loads /overlay/:login/compositor, which itself plays this
 *   account's own WHEP output in a <video> tag (muted - audio is
 *   handled separately below) with the normal SSE-driven overlay
 *   layer on top, exactly like /master.
 *        │
 *        ▼ binary write into ffmpeg.stdin
 *   FFmpeg: image2pipe video + [live-feed audio, music audio] amix
 *        ▼
 *   rtmp://127.0.0.1:1935/composited/<accountId> - this project's own
 *   MediaMTX, which the existing destination-push/republish logic then
 *   reads from exactly like it reads the raw ingest path (see
 *   server.js's compositedPathFor()).
 *
 * This is a genuinely heavy subsystem (a persistent headless Chromium +
 * three ffmpeg processes per account with it enabled) and a real change
 * from the zero-cost passthrough this project defaults to - opt-in per
 * account, off unless explicitly enabled.
 *
 * Deliberately NOT ported from CacheStream, to keep this a bounded v1:
 * hardware-encoder auto-detection/fallback (libx264 software only),
 * periodic Chromium recycle, memory-pressure recycling. The frame-flow
 * watchdog and reconnect-with-backoff ARE ported, since those are what
 * actually keep a multi-hour stream from silently going dark.
 */

function buildChromiumGpuArgs(gpuEnabled) {
  if (!gpuEnabled) return ["--disable-gpu", "--disable-software-rasterizer"];
  return ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy", "--use-gl=egl", "--disable-frame-rate-limit"];
}

function defaultVideoConfig() {
  return {
    width: Number(process.env.COMPOSITOR_WIDTH || 1280),
    height: Number(process.env.COMPOSITOR_HEIGHT || 720),
    fps: Number(process.env.COMPOSITOR_FPS || 30),
    gpuEnabled: String(process.env.COMPOSITOR_GPU || "false").toLowerCase() === "true",
    screencastQuality: Number(process.env.COMPOSITOR_JPEG_QUALITY || 80),
  };
}

class Compositor extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.accountId
   * @param {string} opts.pageUrl - the page Chromium loads (this project's own /overlay/:login/compositor)
   * @param {string} opts.audioSourceUrl - rtmp:// URL to tap this account's own live audio from (the republished public/<login> path)
   * @param {string} opts.outputUrl - rtmp:// URL to push the composited result to (this project's own composited/<accountId> path)
   * @param {() => {mode:string, track:{id:string}|null}} opts.getMusicNow - current shared music-engine state (dashboard/music-engine.js)
   * @param {(path: string) => string} opts.musicFilePathFor - trackId -> absolute file path on disk
   */
  constructor({ accountId, pageUrl, audioSourceUrl, outputUrl, getMusicNow, musicFilePathFor, video, runtimeDir, logger }) {
    super();
    this.accountId = accountId;
    this.pageUrl = pageUrl;
    this.audioSourceUrl = audioSourceUrl;
    this.outputUrl = outputUrl;
    this.getMusicNow = getMusicNow;
    this.musicFilePathFor = musicFilePathFor;
    this.video = { ...defaultVideoConfig(), ...(video || {}) };
    this.runtimeDir = runtimeDir || path.join(os.tmpdir(), "restreamnode-compositor", accountId);
    this.logger = logger || console;

    this.state = "idle"; // idle | starting | running | reconnecting | stopping
    this.shouldRun = false;
    this.error = null;
    this.frameCount = 0;
    this.framesDropped = 0;
    this.lastFrameAt = null;

    this.browser = null;
    this.browserProfileDir = null;
    this.page = null;
    this.client = null;
    this.ffmpeg = null;

    this.liveAudioTap = null;
    this.musicAudioTap = null;
    this.musicAudioFifoFd = null; // keep-alive fd, same trick CacheStream uses for its music fifo
    this.currentMusicTrackId = null;
    this.musicPollTimer = null;

    this.restartTimer = null;
    this.reconnecting = false;
    this.reconnectBackoffMs = 1000;
    this.watchdogTimer = null;
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      frameCount: this.frameCount,
      framesDropped: this.framesDropped,
      lastFrameAt: this.lastFrameAt,
    };
  }

  async start() {
    if (this.state === "running" || this.state === "starting") return;
    this.shouldRun = true;
    this.error = null;
    this._setState("starting");
    try {
      await this._runOnce();
      this.reconnectBackoffMs = 1000;
      this._setState("running");
    } catch (err) {
      this.logger.error(`[compositor:${this.accountId}] start failed: ${err.message}`);
      this.error = err.message;
      this._setState("idle");
      this._scheduleReconnect();
    }
  }

  async stop() {
    this.shouldRun = false;
    this._setState("stopping");
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    await this._teardown();
    this._setState("idle");
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit("status", this.status());
  }

  async _runOnce() {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    this._startLiveAudioTap();
    await this._startMusicAudioTap();
    await this._launchBrowser();
    await this._openScene();
    this._spawnFfmpeg();
    await this._startScreencast();

    this.lastFrameAt = null;
    this._startWatchdog();
    this._startMusicPoll();

    this.logger.log(`[compositor:${this.accountId}] running (${this.video.width}x${this.video.height}@${this.video.fps}, gpu=${this.video.gpuEnabled})`);
  }

  // ---- Chromium ----------------------------------------------------------

  async _launchBrowser() {
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";
    const profileRoot = path.join(this.runtimeDir, "profiles");
    fs.mkdirSync(profileRoot, { recursive: true });
    this.browserProfileDir = fs.mkdtempSync(path.join(profileRoot, "profile-"));

    try {
      this.browser = await puppeteer.launch({
        executablePath: execPath,
        headless: "new",
        userDataDir: this.browserProfileDir,
        defaultViewport: { width: this.video.width, height: this.video.height, deviceScaleFactor: 1 },
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          ...buildChromiumGpuArgs(this.video.gpuEnabled),
          "--no-zygote",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--autoplay-policy=no-user-gesture-required", // the page's <video>/<audio> must play with no user gesture
          "--hide-scrollbars",
          "--mute-audio", // Chromium's own audio output is irrelevant - CDP screencast is video-only, real audio is tapped separately below
          "--disable-features=Translate,BackForwardCache,PaintHolding",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-notifications",
          "--disable-sync",
          "--metrics-recording-only",
          "--no-pings",
          `--window-size=${this.video.width},${this.video.height}`,
        ],
      });
    } catch (err) {
      this._cleanupBrowserProfile();
      throw err;
    }

    this.browser.on("disconnected", () => {
      if (this.shouldRun && this.state !== "stopping") {
        this.logger.warn(`[compositor:${this.accountId}] chromium disconnected`);
        this._scheduleReconnect();
      }
    });
  }

  async _openScene() {
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: this.video.width, height: this.video.height, deviceScaleFactor: 1 });
    await this.page.goto(this.pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  async _startScreencast() {
    this.client = await this.page.target().createCDPSession();
    const cdp = this.client;

    this.client.on("Page.screencastFrame", ({ data, sessionId }) => {
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});

      const ffmpeg = this.ffmpeg;
      if (!ffmpeg) return;
      const stdin = ffmpeg.stdin;
      if (!stdin.writable) return;

      // Backpressure: drop rather than let a stall queue unbounded memory
      // (same reasoning as CacheStream's stream.js - see its comments).
      const BACKPRESSURE_DROP_THRESHOLD = 256 * 1024;
      if (stdin.writableLength > BACKPRESSURE_DROP_THRESHOLD) {
        this.framesDropped++;
        return;
      }

      const buf = Buffer.from(data, "base64");
      this.frameCount++;
      this.lastFrameAt = Date.now();
      stdin.write(buf);
    });

    await this.client.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.video.screencastQuality,
      maxWidth: this.video.width,
      maxHeight: this.video.height,
    });
  }

  // ---- Audio taps ---------------------------------------------------------
  // Two FIFOs, mirroring CacheStream's silence+music split: a writer
  // disappearing (track change, brief network hiccup on the live tap)
  // must never make the MAIN ffmpeg see EOF and kill the whole broadcast.

  _fifoPath(name) {
    return path.join(this.runtimeDir, `${name}.fifo`);
  }

  _ensureFifo(fifoPath) {
    try {
      const stat = fs.statSync(fifoPath);
      if (stat.isFIFO()) { try { fs.chmodSync(fifoPath, 0o666); } catch {} return; }
      fs.unlinkSync(fifoPath);
    } catch (err) {
      if (err.code !== "ENOENT") this.logger.warn(`[compositor:${this.accountId}] fifo stat failed: ${err.message}`);
    }
    fs.mkdirSync(path.dirname(fifoPath), { recursive: true });
    const r = spawnSync("mkfifo", ["-m", "666", fifoPath]);
    if (r.status !== 0) this.logger.warn(`[compositor:${this.accountId}] mkfifo failed: ${r.stderr?.toString()}`);
    try { fs.chmodSync(fifoPath, 0o666); } catch {}
  }

  // Live feed audio: tapped from this account's own already-republished
  // public/<login> path (stable regardless of console/PC failover - see
  // server.js's startRepublish), for as long as the compositor is running.
  _startLiveAudioTap() {
    const fifoPath = this._fifoPath("live-audio");
    this._ensureFifo(fifoPath);
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "warning",
      "-i", this.audioSourceUrl,
      "-vn", "-f", "s16le", "-ar", "44100", "-ac", "2", fifoPath,
    ]);
    child.stderr.on("data", () => {});
    child.on("exit", () => {
      if (this.liveAudioTap === child) this.liveAudioTap = null;
      if (this.shouldRun && this.state !== "stopping") {
        setTimeout(() => { if (this.shouldRun) this._startLiveAudioTap(); }, 2000);
      }
    });
    this.liveAudioTap = child;
  }

  _stopLiveAudioTap() {
    if (!this.liveAudioTap) return;
    const child = this.liveAudioTap;
    this.liveAudioTap = null;
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
  }

  // Music audio: only has a writer while a track is actually playing. We
  // hold our own RDWR fd on the fifo so the main ffmpeg's read-open never
  // blocks waiting for a writer - identical fix to CacheStream's
  // music.fifo keep-alive (see stream.js's _spawnFFmpeg comments).
  async _startMusicAudioTap() {
    const fifoPath = this._fifoPath("music-audio");
    this._ensureFifo(fifoPath);
    if (this.musicAudioFifoFd != null) { try { fs.closeSync(this.musicAudioFifoFd); } catch {} }
    try {
      this.musicAudioFifoFd = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    } catch (err) {
      this.logger.warn(`[compositor:${this.accountId}] could not keep-alive music fifo: ${err.message}`);
      this.musicAudioFifoFd = null;
    }
    this._syncMusicTap();
  }

  // Called on a short poll (see _startMusicPoll) - if the shared music
  // engine's current track changed, kill+respawn the tap pointed at the
  // new file, seeking to the engine's current position so it joins in
  // sync with whatever a Browser-Source music overlay would also be
  // playing right now.
  _syncMusicTap() {
    let now;
    try { now = this.getMusicNow(); } catch { now = null; }
    const trackId = now?.mode === "playing" ? now.track?.id : null;

    if (trackId === this.currentMusicTrackId && (trackId === null || this.musicAudioTap)) return;
    this.currentMusicTrackId = trackId;

    if (this.musicAudioTap) {
      const old = this.musicAudioTap;
      this.musicAudioTap = null;
      old.removeAllListeners("exit");
      old.kill("SIGTERM");
    }
    if (!trackId) return;

    let filePath;
    try { filePath = this.musicFilePathFor(trackId); } catch { return; }
    if (!filePath || !fs.existsSync(filePath)) return;

    const fifoPath = this._fifoPath("music-audio");
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "warning",
      "-ss", String(Math.max(0, now.positionS || 0)),
      "-i", filePath,
      "-vn", "-f", "s16le", "-ar", "44100", "-ac", "2", fifoPath,
    ]);
    child.stderr.on("data", () => {});
    child.on("exit", () => { if (this.musicAudioTap === child) this.musicAudioTap = null; });
    this.musicAudioTap = child;
  }

  _startMusicPoll() {
    this._stopMusicPoll();
    this.musicPollTimer = setInterval(() => this._syncMusicTap(), 2000);
  }
  _stopMusicPoll() {
    if (this.musicPollTimer) { clearInterval(this.musicPollTimer); this.musicPollTimer = null; }
  }

  // ---- Main encode --------------------------------------------------------

  _spawnFfmpeg() {
    const liveAudioFifo = this._fifoPath("live-audio");
    const musicAudioFifo = this._fifoPath("music-audio");

    const args = [
      "-hide_banner", "-loglevel", "warning", "-nostats",

      "-thread_queue_size", "32",
      "-framerate", String(this.video.fps),
      "-use_wallclock_as_timestamps", "1",
      "-f", "image2pipe", "-vcodec", "mjpeg", "-i", "-",

      "-thread_queue_size", "32",
      "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", liveAudioFifo,

      "-thread_queue_size", "32",
      "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", musicAudioFifo,

      "-filter_complex",
      `[0:v]format=yuv420p[v];[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
      "-map", "[v]", "-map", "[a]",

      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-r", String(this.video.fps), "-g", String(this.video.fps * 2),
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",

      "-f", "flv", "-rtmp_live", "live", "-flvflags", "no_duration_filesize",
      this.outputUrl,
    ];

    this.ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    this.ffmpeg.stderr.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line && /error|failed|cannot/i.test(line)) this.logger.warn(`[compositor:${this.accountId}] ffmpeg: ${line}`);
    });
    this.ffmpeg.on("exit", (code, signal) => {
      this.logger.warn(`[compositor:${this.accountId}] ffmpeg exited (code ${code}, signal ${signal})`);
      if (this.shouldRun && this.state !== "stopping") this._scheduleReconnect();
    });
    this.ffmpeg.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") this.logger.warn(`[compositor:${this.accountId}] ffmpeg stdin error: ${err.message}`);
    });
  }

  // ---- Reliability: frame-flow watchdog + reconnect with backoff --------

  _startWatchdog() {
    this._stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (this.state !== "running" || !this.lastFrameAt) return;
      const idleMs = Date.now() - this.lastFrameAt;
      const timeoutMs = Number(process.env.COMPOSITOR_WATCHDOG_MS || 15000);
      if (idleMs > timeoutMs) {
        this.logger.warn(`[compositor:${this.accountId}] watchdog: no frames for ${idleMs}ms, forcing reconnect`);
        this._stopWatchdog();
        this._scheduleReconnect();
      }
    }, 5000);
  }
  _stopWatchdog() {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  }

  _scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.restartTimer || this.reconnecting) return;

    const delay = this.reconnectBackoffMs;
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, 30_000);
    this._setState("reconnecting");

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      this.reconnecting = true;
      try {
        await this._teardown();
        if (!this.shouldRun) { this.reconnecting = false; return; }
        await this._runOnce();
        this.reconnectBackoffMs = 1000;
        this._setState("running");
      } catch (err) {
        this.logger.error(`[compositor:${this.accountId}] reconnect failed: ${err.message}`);
        this.error = err.message;
        this.reconnecting = false;
        this._scheduleReconnect();
        return;
      }
      this.reconnecting = false;
    }, delay);
  }

  // ---- Teardown -----------------------------------------------------------

  async _teardown() {
    this._stopWatchdog();
    this._stopMusicPoll();
    this._stopLiveAudioTap();
    if (this.musicAudioTap) { const c = this.musicAudioTap; this.musicAudioTap = null; c.removeAllListeners("exit"); try { c.kill("SIGTERM"); } catch {} }
    if (this.musicAudioFifoFd != null) { try { fs.closeSync(this.musicAudioFifoFd); } catch {} this.musicAudioFifoFd = null; }
    this.currentMusicTrackId = null;

    const deadline = 10_000;
    const work = (async () => {
      if (this.client) {
        try { await this.client.send("Page.stopScreencast"); } catch {}
        try { await this.client.detach(); } catch {}
        this.client = null;
      }
      if (this.ffmpeg) {
        const proc = this.ffmpeg;
        this.ffmpeg = null;
        try { proc.stdin.end(); } catch {}
        await new Promise((resolve) => {
          const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
          proc.once("exit", () => { clearTimeout(killTimer); resolve(); });
          try { proc.kill("SIGTERM"); } catch { resolve(); }
        });
      }
      if (this.page) { try { await this.page.close({ runBeforeUnload: false }); } catch {} this.page = null; }
      if (this.browser) {
        const proc = this.browser.process?.();
        try { await this.browser.close(); } catch {}
        try { proc?.kill?.("SIGKILL"); } catch {}
        this.browser = null;
      }
      this._cleanupBrowserProfile();
    })();

    let timedOut = false;
    await Promise.race([work, new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, deadline))]);
    if (timedOut) {
      this.logger.warn(`[compositor:${this.accountId}] teardown exceeded deadline, force-killing`);
      try { this.ffmpeg?.kill?.("SIGKILL"); } catch {}
      this.ffmpeg = null;
      try { this.browser?.process?.()?.kill?.("SIGKILL"); } catch {}
      this.browser = null;
      this._cleanupBrowserProfile();
    }
  }

  _cleanupBrowserProfile() {
    const dir = this.browserProfileDir;
    this.browserProfileDir = null;
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { Compositor, defaultVideoConfig };
