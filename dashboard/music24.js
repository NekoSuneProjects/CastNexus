"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Compositor } = require("./compositor");

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "data", "state.json");
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(path.dirname(STATE_FILE), "music");
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8090);
const DASHBOARD_ORIGIN = process.env.DASHBOARD_INTERNAL_ORIGIN || `http://127.0.0.1:${DASHBOARD_PORT}`;
const RTMP_ORIGIN = process.env.MEDIA_RTMP_ORIGIN || "rtmp://127.0.0.1:1935";
const PROFILE_STORE_SYSTEM = "restreamnode-profile-store-v1";
const POLL_MS = Number(process.env.MUSIC24_POLL_MS || 2000);
const NOW_POLL_MS = Number(process.env.MUSIC24_NOW_POLL_MS || 750);

const workers = new Map();
let shuttingDown = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function profileStoreFor(account) {
  return (account?.overlays || []).find(o => o?.config?.system === PROFILE_STORE_SYSTEM) || null;
}

function activeProfileFor(account) {
  const store = profileStoreFor(account)?.config;
  if (!store || !Array.isArray(store.profiles)) return null;
  return store.profiles.find(p => p.id === store.activeProfileId) || null;
}

function sanitizeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function musicSceneUrl(account, profile) {
  const params = new URLSearchParams();
  const visual = profile?.musicVisual || {};
  for (const key of ["accent", "background", "station", "title", "cover"]) {
    if (visual[key]) params.set(key, String(visual[key]));
  }
  const query = params.toString();
  return `${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(account.twitchLogin)}/music${query ? `?${query}` : ""}`;
}

function musicWorkerSignature(account, profile) {
  return JSON.stringify({
    login: account.twitchLogin,
    pcKey: account.pcKey,
    visual: profile?.musicVisual || {},
  });
}

function spawnSilenceFeed(accountId) {
  const streamName = `music-silence/${sanitizeSegment(accountId)}`;
  const outputUrl = `${RTMP_ORIGIN}/${streamName}`;
  const args = [
    "-hide_banner", "-loglevel", "warning", "-nostats",
    "-re", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-g", "2", "-b:v", "32k",
    "-c:a", "aac", "-b:a", "64k", "-ar", "44100", "-ac", "2",
    "-f", "flv", "-flvflags", "no_duration_filesize", "-rtmp_live", "live",
    outputUrl,
  ];
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", chunk => {
    const line = chunk.toString().trim();
    if (line && /error|failed|cannot/i.test(line)) {
      console.warn(`[music24:${accountId}] silence ffmpeg: ${line}`);
    }
  });
  return { child, outputUrl };
}

class Music24Worker {
  constructor(account, profile) {
    this.accountId = account.twitchUserId;
    this.account = account;
    this.profile = profile;
    this.signature = musicWorkerSignature(account, profile);
    this.silence = null;
    this.compositor = null;
    this.now = null;
    this.nowFetchedAt = 0;
    this.nowTimer = null;
    this.running = false;
    this.stopping = false;
  }

  update(account, profile) {
    this.account = account;
    this.profile = profile;
  }

  getNow() {
    if (!this.now) return null;
    const now = { ...this.now };
    if (now.mode === "playing" && now.track) {
      now.positionS = Math.max(0, Number(now.positionS || 0) + (Date.now() - this.nowFetchedAt) / 1000);
    }
    return now;
  }

  musicFilePathFor(trackId) {
    const track = (this.account?.musicTracks || []).find(t => t.id === trackId);
    if (!track) return null;
    return path.join(MUSIC_DIR, this.accountId, track.filename);
  }

  async pollNow() {
    try {
      const url = `${DASHBOARD_ORIGIN}/overlay/${encodeURIComponent(this.account.twitchLogin)}/music/now.json`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      this.now = await res.json();
      this.nowFetchedAt = Date.now();
    } catch {}
  }

  startNowPoll() {
    this.stopNowPoll();
    this.pollNow();
    this.nowTimer = setInterval(() => this.pollNow(), NOW_POLL_MS);
  }

  stopNowPoll() {
    if (this.nowTimer) {
      clearInterval(this.nowTimer);
      this.nowTimer = null;
    }
  }

  async start() {
    if (this.running || this.stopping) return;
    this.running = true;
    this.startNowPoll();

    const startSilence = () => {
      if (!this.running || this.stopping) return;
      const feed = spawnSilenceFeed(this.accountId);
      this.silence = feed;
      feed.child.once("exit", (code) => {
        if (this.silence?.child === feed.child) this.silence = null;
        if (this.running && !this.stopping && !shuttingDown) {
          console.warn(`[music24:${this.accountId}] silence feed exited (${code}); restarting`);
          setTimeout(startSilence, 1500);
        }
      });
    };

    startSilence();
    await sleep(1000);
    if (!this.running || this.stopping) return;

    const silenceUrl = `${RTMP_ORIGIN}/music-silence/${sanitizeSegment(this.accountId)}`;
    const outputUrl = `${RTMP_ORIGIN}/live/${encodeURIComponent(this.account.pcKey)}`;
    this.compositor = new Compositor({
      accountId: `music24-${this.accountId}`,
      pageUrl: musicSceneUrl(this.account, this.profile),
      audioSourceUrl: silenceUrl,
      outputUrl,
      getMusicNow: () => this.getNow(),
      musicFilePathFor: trackId => this.musicFilePathFor(trackId),
      runtimeDir: path.join("/tmp", "restreamnode-music24", sanitizeSegment(this.accountId)),
      logger: console,
    });

    await this.compositor.start();
    console.log(`[music24:${this.accountId}] 24/7 music broadcast started -> live/${this.account.pcKey}`);
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    this.stopNowPoll();

    if (this.compositor) {
      try { await this.compositor.stop(); } catch {}
      this.compositor = null;
    }

    if (this.silence?.child) {
      const child = this.silence.child;
      child.removeAllListeners("exit");
      try { child.kill("SIGTERM"); } catch {}
      this.silence = null;
    }

    this.stopping = false;
    console.log(`[music24:${this.accountId}] stopped`);
  }
}

async function reconcile() {
  const state = readState();
  if (!state?.accounts) return;
  const desired = new Set();

  for (const account of Object.values(state.accounts)) {
    const profile = activeProfileFor(account);
    const wantsMusic = profile?.mode === "music" && profile?.musicAutostart !== false;
    const hasTracks = Array.isArray(account.musicTracks) && account.musicTracks.length > 0;
    const ready = wantsMusic && hasTracks && account.pcKey && account.twitchLogin;
    if (!ready) continue;

    desired.add(account.twitchUserId);
    const sig = musicWorkerSignature(account, profile);
    let worker = workers.get(account.twitchUserId);

    if (worker && worker.signature !== sig) {
      await worker.stop();
      workers.delete(account.twitchUserId);
      worker = null;
    }

    if (!worker) {
      worker = new Music24Worker(account, profile);
      workers.set(account.twitchUserId, worker);
      worker.start().catch(err => {
        console.error(`[music24:${account.twitchUserId}] start failed: ${err.message}`);
      });
    } else {
      worker.update(account, profile);
    }
  }

  for (const [accountId, worker] of [...workers.entries()]) {
    if (desired.has(accountId)) continue;
    await worker.stop();
    workers.delete(accountId);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[music24] ${signal} received; stopping workers`);
  for (const worker of workers.values()) {
    try { await worker.stop(); } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", err => console.error("[music24] unhandled rejection", err));

console.log(`[music24] watching ${STATE_FILE} for active 24/7 music profiles`);
reconcile();
setInterval(() => reconcile().catch(err => console.error("[music24] reconcile failed", err)), POLL_MS);
