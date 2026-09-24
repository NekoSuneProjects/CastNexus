"use strict";

// Browser-source audio capture for the server-side compositor.
//
// StreamElements/Streamlabs alerts, browser music widgets and custom HTML can
// all play sound. Chromium used to run with --mute-audio, so that sound was
// silently dropped. When a scene contains audio-enabled browser layers:
//
//   Chromium (sandbox + site isolation unchanged)
//      -> PULSE_SINK = cn_<compositor>        a private PulseAudio null sink
//      -> ffmpeg -f pulse -i cn_<id>.monitor  s16le 48 kHz stereo PCM
//      -> PcmAudioRelay (paced, live gain)    the "browser" mixer bus
//      -> compositor amix with OBS/program audio and music
//
// Pages get no new capability: they play audio exactly as in a normal browser.
// Nothing about the host is exposed to them; the sink exists only inside the
// container's user-level PulseAudio daemon.
//
// Per-layer volume/mute is applied inside each iframe's own document by the
// compositor via DevTools (see layerVolumeScript), so several overlays can
// play at once at independent levels without touching the program audio.

const { spawn, spawnSync } = require("node:child_process");

const PACTL = process.env.PACTL_BIN || "pactl";
const PULSEAUDIO = process.env.PULSEAUDIO_BIN || "pulseaudio";
let daemonChecked = false;
let daemonAvailable = false;
let lastDaemonAttempt = 0;

function enabledByEnv() {
  const v = String(process.env.CASTNEXUS_BROWSER_AUDIO || "auto").toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

function sinkNameFor(id) {
  return `cn_${String(id || "compositor").replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 48)}`;
}

function pactl(args, timeout = 4000) {
  try {
    const r = spawnSync(PACTL, args, { encoding:"utf8", timeout });
    return { ok:r.status === 0, stdout:String(r.stdout || ""), stderr:String(r.stderr || r.error?.message || "") };
  } catch (error) {
    return { ok:false, stdout:"", stderr:error.message };
  }
}

// Start a per-container user daemon if none is reachable. Docker images run
// one process tree, so there is no system PulseAudio to talk to.
function ensureDaemon({ platform = process.platform } = {}) {
  if (platform !== "linux" || !enabledByEnv()) return false;
  if (daemonChecked && daemonAvailable) return true;
  // A failed start is remembered for a minute: retrying runs synchronous
  // pactl/pulseaudio calls that would otherwise stall the dashboard each time.
  if (daemonChecked && Date.now() - lastDaemonAttempt < 60000) return false;
  daemonChecked = true;
  lastDaemonAttempt = Date.now();
  if (pactl(["info"]).ok) return (daemonAvailable = true);
  try {
    if (process.env.XDG_RUNTIME_DIR) require("node:fs").mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive:true, mode:0o700 });
    const r = spawnSync(PULSEAUDIO, [
      "--daemonize=yes", "--exit-idle-time=-1", "--disallow-exit",
      "--disable-shm=true", "--log-target=stderr", "--log-level=error",
      // No hardware modules: the container has no sound card, only null sinks.
      "-n", "--load=module-native-protocol-unix", "--load=module-null-sink sink_name=cn_default",
    ], { encoding:"utf8", timeout:8000 });
    if (r.error) return (daemonAvailable = false);
  } catch {
    return (daemonAvailable = false);
  }
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 20; i++) {
    if (pactl(["info"]).ok) return (daemonAvailable = true);
    Atomics.wait(pause, 0, 0, 100);
  }
  return (daemonAvailable = false);
}

function createSink(name) {
  const r = pactl(["load-module", "module-null-sink", `sink_name=${name}`, `sink_properties=device.description=${name}`]);
  if (!r.ok) return null;
  const moduleId = Number(r.stdout.trim());
  return Number.isInteger(moduleId) ? moduleId : null;
}

function removeSink(moduleId) {
  if (moduleId == null) return;
  pactl(["unload-module", String(moduleId)]);
}

function captureArgs(sinkName, output, { debug = false } = {}) {
  return [
    "-hide_banner", "-loglevel", debug ? "info" : "warning", "-nostdin", "-y",
    "-f", "pulse", "-fragment_size", "3840", "-i", `${sinkName}.monitor`,
    "-vn", "-af", "aresample=async=1:first_pts=0",
    "-f", "s16le", "-ar", "48000", "-ac", "2", output,
  ];
}

class BrowserAudioCapture {
  constructor({ id, ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg", logger = console, debug = false }) {
    this.id = id;
    this.sinkName = sinkNameFor(id);
    this.ffmpegBin = ffmpegBin;
    this.logger = logger;
    this.debug = debug;
    this.moduleId = null;
    this.child = null;
    this.output = null;
    this.stopped = true;
    this.available = false;
    this.error = null;
  }

  // Environment for the Chromium process so its audio lands in our sink.
  chromiumEnv() {
    return this.available ? { PULSE_SINK:this.sinkName } : {};
  }

  prepare() {
    this.error = null;
    if (!ensureDaemon()) {
      this.available = false;
      this.error = process.platform === "linux" ? "PulseAudio is not available (install pulseaudio or set CASTNEXUS_BROWSER_AUDIO=false)" : "browser audio capture requires the Linux/Docker runtime";
      return false;
    }
    if (this.moduleId == null) this.moduleId = createSink(this.sinkName);
    this.available = this.moduleId != null;
    if (!this.available) this.error = `could not create PulseAudio sink ${this.sinkName}`;
    return this.available;
  }

  start(output) {
    this.output = output;
    this.stopped = false;
    if (!this.available) return false;
    this._spawn();
    return true;
  }

  _spawn() {
    if (this.stopped || !this.available) return;
    const child = spawn(this.ffmpegBin, captureArgs(this.sinkName, this.output, { debug:this.debug }), { stdio:["ignore", "ignore", "pipe"] });
    child.stderr.on("data", chunk => {
      const line = chunk.toString().trim();
      if (line && (this.debug || /error|fail|refused/i.test(line))) this.logger.warn?.(`[browser-audio:${this.id}] ${line}`);
    });
    child.on("error", error => { this.error = error.message; });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      if (!this.stopped) setTimeout(() => this._spawn(), 1500);
    });
    this.child = child;
  }

  pid() { return this.child?.pid || null; }

  stop() {
    this.stopped = true;
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.removeAllListeners("exit");
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000).unref?.();
    }
    removeSink(this.moduleId);
    this.moduleId = null;
    this.available = false;
  }
}

// Injected into each browser-layer frame (and its nested frames) by the
// compositor over DevTools. It scales every <audio>/<video> element and every
// Web Audio graph in that document by the layer's volume, and keeps doing so
// for media created later. It runs in the page's own origin, so it grants the
// page nothing it did not already have.
function layerVolumeScript() {
  return function applyCastNexusLayerVolume(volume, muted) {
    const level = muted ? 0 : Math.max(0, Math.min(1, Number(volume)));
    window.__cnLayerVolume = Number.isFinite(level) ? level : 1;
    if (!window.__cnLayerVolumePatched) {
      window.__cnLayerVolumePatched = true;
      const proto = HTMLMediaElement.prototype;
      const volumeDesc = Object.getOwnPropertyDescriptor(proto, "volume");
      const setReal = (el, value) => { try { volumeDesc.set.call(el, Math.max(0, Math.min(1, value))); } catch {} };
      const applyTo = el => setReal(el, (el.__cnRequestedVolume ?? 1) * window.__cnLayerVolume);
      Object.defineProperty(proto, "volume", {
        configurable:true,
        get() { return this.__cnRequestedVolume ?? volumeDesc.get.call(this); },
        set(value) { this.__cnRequestedVolume = Number(value); applyTo(this); },
      });
      const play = proto.play;
      proto.play = function castNexusPlay() { applyTo(this); return play.apply(this, arguments); };
      document.addEventListener("play", event => { if (event.target instanceof HTMLMediaElement) applyTo(event.target); }, true);
      const gains = [];
      const Base = window.BaseAudioContext || window.AudioContext || window.webkitAudioContext;
      const destDesc = Base && Object.getOwnPropertyDescriptor(Base.prototype, "destination");
      if (destDesc?.get) {
        Object.defineProperty(Base.prototype, "destination", {
          configurable:true,
          get() {
            if (!this.__cnGain) {
              const real = destDesc.get.call(this);
              const gain = this.createGain();
              gain.gain.value = window.__cnLayerVolume;
              gain.connect(real);
              this.__cnGain = gain;
              gains.push(gain);
            }
            return this.__cnGain;
          },
        });
      }
      window.__cnApplyLayerVolume = () => {
        document.querySelectorAll("audio,video").forEach(applyTo);
        for (const gain of gains) { try { gain.gain.value = window.__cnLayerVolume; } catch {} }
      };
    }
    window.__cnApplyLayerVolume();
    return window.__cnLayerVolume;
  };
}

module.exports = {
  enabledByEnv,
  sinkNameFor,
  ensureDaemon,
  createSink,
  removeSink,
  captureArgs,
  BrowserAudioCapture,
  layerVolumeScript,
};
