const { spawn } = require("node:child_process");

// Server-authoritative music timeline shared by the Studio, browser scenes and
// the headless 24/7 compositor. Browsers join this timeline; they do not pick
// the next track independently.

function probeDurationSeconds(filePath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", filePath]);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve(null));
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

const FALLBACK_DURATION_S = 180;

function shuffledOrder(values) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class AccountMusicEngine {
  constructor(getAccount, onAdvance) {
    this.getAccount = getAccount;
    this.onAdvance = onAdvance;
    this.timer = null;
    this.trackId = null;
    this.startedAt = 0;
    this.durationS = 0;
    // Track IDs are stable while array indexes are not. The previous index
    // order could stay as [0] after another song was uploaded mid-playback,
    // causing track 1 to loop forever instead of ever reaching track 2.
    this.playOrder = [];
    this.pos = 0;
    this.librarySignature = "";
    this.shuffleMode = null;
  }

  _tracks() { return this.getAccount()?.musicTracks || []; }
  _settings() { return this.getAccount()?.musicSettings || { shuffle: false, loop: true, volume: 0.7 }; }
  _signature(tracks = this._tracks()) { return tracks.map((track) => track.id).join("\u0000"); }

  _rebuildOrder({ keepCurrent = true, avoidFirst = null } = {}) {
    const tracks = this._tracks();
    const ids = tracks.map((track) => track.id);
    const shuffle = Boolean(this._settings().shuffle);
    let order = shuffle ? shuffledOrder(ids) : ids;

    // Do not repeat the last track immediately when a shuffled loop starts a
    // fresh cycle and another track exists.
    if (avoidFirst && order.length > 1 && order[0] === avoidFirst) {
      const swap = order.findIndex((id) => id !== avoidFirst);
      if (swap > 0) [order[0], order[swap]] = [order[swap], order[0]];
    }

    this.playOrder = order;
    this.librarySignature = this._signature(tracks);
    this.shuffleMode = shuffle;
    if (keepCurrent && this.trackId && order.includes(this.trackId)) this.pos = order.indexOf(this.trackId);
    else this.pos = 0;
  }

  _syncOrder() {
    const signature = this._signature();
    const shuffle = Boolean(this._settings().shuffle);
    if (signature !== this.librarySignature || shuffle !== this.shuffleMode || !this.playOrder.length) {
      this._rebuildOrder({ keepCurrent: true });
    }
  }

  ensureRunning() {
    if (this._tracks().length === 0) return;
    this._syncOrder();
    if (this.timer && this.trackId) return;
    this._playAt(0);
  }

  stop({ notify = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    this.trackId = null;
    this.startedAt = 0;
    this.durationS = 0;
    if (notify) this.onAdvance?.(this.getNow());
  }

  // Called after tracks or playback settings change. Rebuild upcoming order
  // but keep the current song and clock if that song still exists.
  refresh() {
    const tracks = this._tracks();
    if (tracks.length === 0) { this.stop({ notify: true }); return; }
    const currentStillExists = Boolean(this.trackId && tracks.some((track) => track.id === this.trackId));
    this._rebuildOrder({ keepCurrent: currentStillExists });
    if (!currentStillExists) {
      clearTimeout(this.timer);
      this.timer = null;
      this._playAt(0);
    }
  }

  _playAt(i) {
    const tracks = this._tracks();
    if (tracks.length === 0) { this.stop({ notify: true }); return; }
    this._syncOrder();
    if (!this.playOrder.length) { this.stop({ notify: true }); return; }
    if (i >= this.playOrder.length) i = 0;

    const id = this.playOrder[Math.max(0, i)];
    const track = tracks.find((candidate) => candidate.id === id);
    if (!track) {
      this._rebuildOrder({ keepCurrent: false });
      const retry = tracks.find((candidate) => candidate.id === this.playOrder[0]);
      if (!retry) { this.stop({ notify: true }); return; }
      return this._startTrack(retry, 0);
    }
    this._startTrack(track, Math.max(0, i));
  }

  _startTrack(track, pos) {
    this.pos = pos;
    this.trackId = track.id;
    this.startedAt = Date.now();
    this.durationS = Number(track.durationS) > 0 ? Number(track.durationS) : FALLBACK_DURATION_S;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._advance(), Math.max(250, this.durationS * 1000));
    this.onAdvance?.(this.getNow());
  }

  _advance() {
    const tracks = this._tracks();
    if (tracks.length === 0) { this.stop({ notify: true }); return; }
    this._syncOrder();

    const currentPos = this.playOrder.indexOf(this.trackId);
    this.pos = currentPos >= 0 ? currentPos : this.pos;
    const next = this.pos + 1;
    if (next < this.playOrder.length) {
      this._playAt(next);
      return;
    }

    if (!this._settings().loop) {
      this.stop({ notify: true });
      return;
    }

    const previous = this.trackId;
    this._rebuildOrder({ keepCurrent: false, avoidFirst: previous });
    this._playAt(0);
  }

  getNow() {
    const tracks = this._tracks();
    const track = tracks.find((candidate) => candidate.id === this.trackId);
    if (!track) return { mode: "idle", track: null, positionS: 0, durationS: 0, volume: this._settings().volume ?? 0.7 };
    return {
      mode: "playing",
      track: { id: track.id, title: track.title, artist: track.artist },
      positionS: Math.min(this.durationS, Math.max(0, (Date.now() - this.startedAt) / 1000)),
      durationS: this.durationS,
      volume: this._settings().volume ?? 0.7,
    };
  }
}

const engines = new Map();

function engineFor(accountId, getAccount, onAdvance) {
  let engine = engines.get(accountId);
  if (!engine) {
    engine = new AccountMusicEngine(getAccount, onAdvance);
    engines.set(accountId, engine);
  }
  return engine;
}

module.exports = { engineFor, probeDurationSeconds, AccountMusicEngine, shuffledOrder };
