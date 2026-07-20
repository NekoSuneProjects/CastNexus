const { spawn } = require("node:child_process");

// One shared "now playing" state per account - mirrors CacheStream's single
// MusicEngine instance (apps/web/src/lib/music.ts) so every overlay/widget
// that shows now-playing info agrees, instead of each browser source
// independently picking its own track. What's deliberately NOT ported: its
// FFmpeg->FIFO audio-mixing pipeline into a compositor. This project has no
// server-side compositor to feed - PC-mode audio is meant to be captured by
// OBS's own Browser Source, and console mode has no compositor at all (see
// docs/design/overlays.md §5) - so actual playback still happens client-side
// via the overlay page's own <audio> element. The server's job is just to be
// the single authority on "which track, and how far into it," which the
// client-side player joins mid-song to stay in sync.

function probeDurationSeconds(filePath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", filePath]);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve(null)); // ffprobe missing - degrade gracefully, see FALLBACK_DURATION_S
    child.on("close", () => {
      try {
        const seconds = Number(JSON.parse(out).format?.duration);
        resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
      } catch {
        resolve(null);
      }
    });
  });
}

const FALLBACK_DURATION_S = 180; // used only if duration probing ever fails

function shuffledOrder(tracks) {
  const idx = tracks.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

class AccountMusicEngine {
  constructor(getAccount, onAdvance) {
    this.getAccount = getAccount; // () => current account object (tracks/settings live there)
    this.onAdvance = onAdvance;   // called with the new getNow() whenever the track changes
    this.timer = null;
    this.trackId = null;
    this.startedAt = 0;
    this.durationS = 0;
    this.playOrder = [];
    this.pos = 0;
  }

  _tracks() { return this.getAccount()?.musicTracks || []; }
  _settings() { return this.getAccount()?.musicSettings || { shuffle: false, loop: true, volume: 0.7 }; }

  ensureRunning() {
    if (this.timer || this._tracks().length === 0) return;
    this._playAt(0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.trackId = null;
  }

  // Call after tracks are added/removed so a mid-edit doesn't leave playback
  // pointed at a track that no longer exists.
  refresh() {
    const tracks = this._tracks();
    if (tracks.length === 0) { this.stop(); return; }
    if (!this.trackId || !tracks.some((t) => t.id === this.trackId)) {
      clearTimeout(this.timer);
      this.timer = null;
      this._playAt(0);
    }
  }

  _playAt(i) {
    const tracks = this._tracks();
    if (tracks.length === 0) { this.stop(); return; }
    if (!this.playOrder.length || i >= this.playOrder.length) {
      this.playOrder = this._settings().shuffle ? shuffledOrder(tracks) : tracks.map((_, idx) => idx);
      i = 0;
    }
    this.pos = i;
    const track = tracks[this.playOrder[i]];
    if (!track) { this.stop(); return; }
    this.trackId = track.id;
    this.startedAt = Date.now();
    this.durationS = track.durationS || FALLBACK_DURATION_S;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._advance(), this.durationS * 1000);
    this.onAdvance?.(this.getNow());
  }

  _advance() {
    const tracks = this._tracks();
    if (tracks.length === 0) { this.stop(); return; }
    const next = this.pos + 1;
    if (next >= this.playOrder.length && !this._settings().loop) { this.stop(); return; }
    this._playAt(next >= this.playOrder.length ? 0 : next);
  }

  getNow() {
    const tracks = this._tracks();
    const track = tracks.find((t) => t.id === this.trackId);
    if (!track) return { mode: "idle", track: null, positionS: 0, durationS: 0, volume: this._settings().volume ?? 0.7 };
    return {
      mode: "playing",
      track: { id: track.id, title: track.title, artist: track.artist },
      positionS: Math.max(0, (Date.now() - this.startedAt) / 1000),
      durationS: this.durationS,
      volume: this._settings().volume ?? 0.7,
    };
  }
}

const engines = new Map(); // accountId -> AccountMusicEngine

function engineFor(accountId, getAccount, onAdvance) {
  let engine = engines.get(accountId);
  if (!engine) {
    engine = new AccountMusicEngine(getAccount, onAdvance);
    engines.set(accountId, engine);
  }
  return engine;
}

module.exports = { engineFor, probeDurationSeconds };
