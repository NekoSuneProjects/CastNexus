const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

// These pages are served publicly (no auth) since OBS Browser Sources can't
// log in - same trust model this project already uses for the
// `public/<twitch-username>` playback paths: unauthenticated, but scoped to
// an unguessable-enough per-account path.

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const AUDIO_MIME = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".oga": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac",
  ".opus": "audio/opus", ".weba": "audio/webm",
};

function page({ title, body, bodyCss = "", transparent = true }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
  body {
    background: ${transparent ? "transparent" : "#05060a"};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  ${bodyCss}
</style></head>
<body>${body}</body></html>`;
}

// ---------------------------------------------------------------------------
// "Now Playing" mini-widget - layerable onto ANY scene fragment, the same
// way CacheStream's OverlayConfigCard toggles it onto every one of its scene
// templates via a shared wrapper (SceneFrame.tsx). Reads the same
// server-authoritative music engine state as the dedicated music overlay.

const CORNER_CSS = {
  br: "bottom:24px; right:24px;", bl: "bottom:24px; left:24px;",
  tr: "top:24px; right:24px;", tl: "top:24px; left:24px;",
};

function nowPlayingWidget(login, corner) {
  const pos = CORNER_CSS[corner] || CORNER_CSS.br;
  return `
    <aside id="cs-now-playing" style="position:fixed; ${pos} display:none; gap:12px; align-items:center; background:rgba(10,10,14,.65); padding:10px 14px; border-radius:10px; color:#fff; max-width:280px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="font-size:22px;">&#9835;</div>
      <div>
        <div style="font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:#9aa0ac;">Now playing</div>
        <div id="cs-np-title" style="font-weight:700; font-size:13px;">&mdash;</div>
        <div id="cs-np-artist" style="font-size:11px; color:#c8c8d0;"></div>
      </div>
    </aside>
    <script>
      (function () {
        function poll() {
          fetch(${JSON.stringify(`/overlay/${encodeURIComponent(login)}/music/now.json`)}, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (now) {
              var el = document.getElementById("cs-now-playing");
              if (!now || now.mode !== "playing" || !now.track) { el.style.display = "none"; return; }
              el.style.display = "flex";
              document.getElementById("cs-np-title").textContent = now.track.title || "Untitled";
              document.getElementById("cs-np-artist").textContent = now.track.artist || "";
            })
            .catch(function () {});
        }
        poll();
        setInterval(poll, 2000);
      })();
    </script>`;
}

// Applies the account's global overlay-widget toggles to any scene
// fragment - the same "layer these on every scene" concept as
// OverlayConfigCard, just with one widget ported so far (now-playing).
function withWidgets(fragment, overlayConfig, login) {
  const np = overlayConfig?.nowPlaying;
  if (!np?.enabled) return fragment;
  return fragment + nowPlayingWidget(login, np.corner);
}

// ---------------------------------------------------------------------------
// Standby scenes (Starting Soon / BRB / Ending) - each has a "Fragment"
// (inner HTML only, used by both the standalone route AND the master
// scene-switcher) and a full page wrapper (for the standalone route).

function countdownBlock(countdownAt, countdownLabel) {
  if (!countdownAt) return "";
  const iso = new Date(countdownAt).toISOString();
  if (Number.isNaN(Date.parse(iso))) return "";
  return `
    <div id="cd" style="margin-top:22px; font-size:40px; font-weight:700; font-variant-numeric:tabular-nums; color:#fff;"></div>
    <script>
      (function () {
        var target = new Date(${JSON.stringify(iso)}).getTime();
        var el = document.getElementById("cd");
        function pad(n) { return String(n).padStart(2, "0"); }
        function tick() {
          var diff = Math.max(0, target - Date.now());
          var h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
          el.textContent = ${JSON.stringify(countdownLabel || "Live in")} + " " + pad(h) + ":" + pad(m) + ":" + pad(s);
        }
        tick();
        setInterval(tick, 1000);
      })();
    </script>`;
}

function standbySceneFragment({ title, subtitle, accent, backgroundUrl, extra }) {
  const bg = backgroundUrl
    ? `background: linear-gradient(rgba(2,3,6,.55), rgba(2,3,6,.55)), url('${escapeHtml(backgroundUrl)}') center/cover no-repeat, #05060a;`
    : `background: radial-gradient(circle at 50% 42%, ${escapeHtml(accent)}22, #05060a 70%);`;
  return `
    <div style="${bg} width:100vw; height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#fff; text-align:center;">
      <div style="font-size:64px; font-weight:800; letter-spacing:.02em; text-shadow:0 0 30px ${escapeHtml(accent)}aa;">${escapeHtml(title)}</div>
      ${subtitle ? `<div style="margin-top:14px; font-size:24px; color:#c8ccd6;">${escapeHtml(subtitle)}</div>` : ""}
      ${extra || ""}
    </div>`;
}

function startingSoonFragment(cfg, query = {}) {
  return standbySceneFragment({
    title: query.title || cfg.title || "Starting Soon",
    subtitle: query.subtitle || cfg.subtitle || "",
    accent: query.accent || cfg.accent || "#7c5cff",
    backgroundUrl: query.background || cfg.backgroundUrl || "",
    extra: countdownBlock(query.at || cfg.countdownAt, cfg.countdownLabel),
  });
}

function brbFragment(cfg, query = {}) {
  return standbySceneFragment({
    title: query.title || cfg.title || "BRB",
    subtitle: query.subtitle || cfg.subtitle || "Be right back",
    accent: query.accent || cfg.accent || "#8a2bff",
    backgroundUrl: query.background || cfg.backgroundUrl || "",
  });
}

function endingFragment(cfg, query = {}) {
  const handles = [
    ["Twitch", query.twitch || cfg.twitch],
    ["YouTube", query.youtube || cfg.youtube],
    ["X", query.twitter || cfg.twitter],
    ["Discord", query.discord || cfg.discord],
  ].filter(([, v]) => v);
  const extra = handles.length
    ? `<div style="margin-top:18px; display:flex; gap:18px; font-size:18px; color:#dfe3ee;">${
        handles.map(([label, v]) => `<span>${escapeHtml(label)}: ${escapeHtml(v)}</span>`).join("")
      }</div>`
    : "";
  return standbySceneFragment({
    title: query.title || cfg.title || "Thanks for watching",
    subtitle: query.subtitle || cfg.subtitle || "Stream over",
    accent: query.accent || cfg.accent || "#ff2bd6",
    backgroundUrl: query.background || cfg.backgroundUrl || "",
    extra,
  });
}

function liveBadgePage(login, cfg) {
  const accent = cfg.accent || "#35d07f";
  const body = `
    <div id="wrap" style="position:fixed; bottom:24px; right:24px; display:none; align-items:center; gap:10px; background:rgba(0,0,0,.55); padding:10px 18px; border-radius:999px; color:#fff; font-weight:700; font-size:16px;">
      <span style="width:12px; height:12px; border-radius:50%; background:${escapeHtml(accent)}; box-shadow:0 0 10px ${escapeHtml(accent)}; animation:cs-pulse 1.4s infinite;"></span>
      <span id="label">${escapeHtml(cfg.title || "LIVE")}</span>
    </div>
    <style>@keyframes cs-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }</style>
    <script>
      (function () {
        function poll() {
          fetch(${JSON.stringify(`/overlay/${encodeURIComponent(login)}/live-status.json`)}, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (data) { document.getElementById("wrap").style.display = data.live ? "flex" : "none"; })
            .catch(function () {});
        }
        poll();
        setInterval(poll, 2000);
      })();
    </script>`;
  return page({ title: cfg.title || "Live", body });
}

function textOverlayFragment(overlay) {
  const cfg = overlay.config || {};
  return `
    <div style="position:fixed; inset:0; display:flex; align-items:center; justify-content:center;">
      <div style="font-size:${Number(cfg.fontSize) || 48}px; color:${escapeHtml(cfg.color || "#ffffff")}; text-align:center; text-shadow:0 2px 12px rgba(0,0,0,.6); white-space:pre-wrap;">${escapeHtml(cfg.text || "")}</div>
    </div>`;
}

function htmlOverlayFragment(overlay) {
  const cfg = overlay.config || {};
  // Deliberately NOT escaped - this is the explicit "raw HTML" escape hatch,
  // same tradeoff CacheStream's raw_html template accepts: you're trusted
  // with your own overlay, but a typo here breaks the broadcast, not anyone
  // else's. Its own <style> (cfg.css) is appended inline since fragments
  // (unlike full pages via page()) have no <head> to put a <style> tag in.
  return `${cfg.css ? `<style>${cfg.css}</style>` : ""}${cfg.html || ""}`;
}

function musicOverlayPage(login) {
  const body = `
    <aside id="card" style="position:fixed; bottom:24px; left:24px; display:flex; gap:12px; align-items:center; background:rgba(10,10,14,.65); padding:12px 16px; border-radius:10px; color:#fff; max-width:320px; opacity:0; transition:opacity .3s;">
      <div style="font-size:28px;">&#9835;</div>
      <div>
        <div style="font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#9aa0ac; margin-bottom:2px;">Now playing</div>
        <div id="t" style="font-weight:700;">&mdash;</div>
        <div id="a" style="font-size:12px; color:#c8c8d0;"></div>
      </div>
    </aside>
    <audio id="player"></audio>
    <script>
      (function () {
        var loadedTrackId = null;
        var audio = document.getElementById("player");
        var card = document.getElementById("card");
        function apply(now) {
          if (!now || now.mode !== "playing" || !now.track) { card.style.opacity = "0"; return; }
          card.style.opacity = "1";
          document.getElementById("t").textContent = now.track.title || "Untitled";
          document.getElementById("a").textContent = now.track.artist || "";
          audio.volume = Math.min(1, Math.max(0, Number(now.volume) || 0.7));
          if (now.track.id !== loadedTrackId) {
            // A different track than what's currently loaded (either a real
            // track change, or this page just (re)loaded mid-song) - join
            // the server's authoritative timeline instead of starting over,
            // so every overlay instance stays in sync.
            loadedTrackId = now.track.id;
            audio.src = ${JSON.stringify(`/overlay/${encodeURIComponent(login)}/music/file/`)} + now.track.id;
            audio.currentTime = now.positionS || 0;
            audio.play().catch(function () {});
          }
        }
        function poll() {
          fetch(${JSON.stringify(`/overlay/${encodeURIComponent(login)}/music/now.json`)}, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(apply)
            .catch(function () {});
        }
        poll();
        setInterval(poll, 1000);
      })();
    </script>`;
  return page({ title: "Music", body });
}

// ---------------------------------------------------------------------------
// Master scene switcher - the ONE stable Browser Source URL an operator adds
// once. The dashboard's scene-switch action updates server-side state and
// pushes an SSE event here; this page swaps its own content in place with no
// navigation, so nothing in OBS ever needs to be touched to "switch scenes."
// This is the adapted equivalent of CacheStream's mechanism (see
// docs/design/overlays.md's implementation-notes callout): CacheStream
// achieves the same "no manual OBS reconfiguration" outcome by navigating a
// headless browser IT owns; we don't own the browser tab (OBS does), so we
// push a live update into the same already-loaded page instead.

function resolveSceneFragment(scene, account) {
  const cfg = account.overlayConfig || {};
  if (!scene || scene.kind === "none") return "";
  if (scene.kind === "builtin") {
    if (scene.name === "startingSoon") return startingSoonFragment(cfg.startingSoon || {});
    if (scene.name === "brb") return brbFragment(cfg.brb || {});
    if (scene.name === "ending") return endingFragment(cfg.ending || {});
    return "";
  }
  if (scene.kind === "custom") {
    const overlay = (account.overlays || []).find((o) => o.id === scene.overlayId);
    if (!overlay) return "";
    if (overlay.type === "text") return textOverlayFragment(overlay);
    if (overlay.type === "html") return htmlOverlayFragment(overlay);
  }
  return "";
}

function masterPage(login, initialFragment) {
  const body = `
    <div id="scene-root">${initialFragment}</div>
    <script>
      (function () {
        var root = document.getElementById("scene-root");
        var es = new EventSource(${JSON.stringify(`/overlay/${encodeURIComponent(login)}/events`)});
        es.onmessage = function (e) {
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === "scene") root.innerHTML = msg.html;
          } catch (err) {}
        };
        // EventSource auto-reconnects on its own if the connection drops -
        // nothing else to do here.
      })();
    </script>`;
  return page({ title: "Live scene", body, transparent: true });
}

// ---------------------------------------------------------------------------
// Compositor page - loaded by the OPTIONAL built-in compositor
// (dashboard/compositor.js), a headless Chromium instance that screencasts
// this exact page and re-encodes it, the same mechanism CacheStream uses.
// Unlike CacheStream (whose page IS the entire video - no external feed at
// all), this page plays the account's own live output as a background
// <video> via WHEP (lowest latency of the playback protocols already
// served), with the normal SSE-driven overlay layer on top - same
// scene-switch mechanic as /master, just with real video underneath.
// Audio is NOT taken from this <video> element (CDP screencast is
// video-only) - it's tapped separately server-side, see compositor.js.

function whepClientScript(whepUrl) {
  return `
    <script>
      (function () {
        function connectWhep() {
          var pc = new RTCPeerConnection();
          pc.addTransceiver("video", { direction: "recvonly" });
          pc.addTransceiver("audio", { direction: "recvonly" });
          var video = document.getElementById("bg-video");
          pc.ontrack = function (ev) {
            if (video.srcObject !== ev.streams[0]) video.srcObject = ev.streams[0];
          };
          pc.oniceconnectionstatechange = function () {
            if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
              try { pc.close(); } catch (e) {}
              setTimeout(connectWhep, 3000);
            }
          };
          pc.createOffer().then(function (offer) {
            return pc.setLocalDescription(offer);
          }).then(function () {
            return new Promise(function (resolve) {
              if (pc.iceGatheringState === "complete") return resolve();
              pc.addEventListener("icegatheringstatechange", function onchange() {
                if (pc.iceGatheringState === "complete") { pc.removeEventListener("icegatheringstatechange", onchange); resolve(); }
              });
            });
          }).then(function () {
            return fetch(${JSON.stringify(whepUrl)}, {
              method: "POST",
              headers: { "Content-Type": "application/sdp" },
              body: pc.localDescription.sdp,
            });
          }).then(function (res) {
            if (!res.ok) throw new Error("WHEP offer rejected: " + res.status);
            return res.text();
          }).then(function (answer) {
            return pc.setRemoteDescription({ type: "answer", sdp: answer });
          }).catch(function () {
            // Account may not be live yet, or MediaMTX hasn't got the path
            // ready - a fresh RTCPeerConnection is needed per attempt (WHEP
            // has no "retry the same offer" concept), so just try again.
            try { pc.close(); } catch (e) {}
            setTimeout(connectWhep, 3000);
          });
        }
        connectWhep();
      })();
    </script>`;
}

function compositorPage(login, initialFragment) {
  const whepUrl = "/" + ["webrtc", "public", login, "whep"].map(encodeURIComponent).join("/");
  const body = `
    <video id="bg-video" autoplay muted playsinline style="position:fixed; inset:0; width:100vw; height:100vh; object-fit:cover; background:#000;"></video>
    <div id="scene-root" style="position:fixed; inset:0;">${initialFragment}</div>
    <script>
      (function () {
        var root = document.getElementById("scene-root");
        var es = new EventSource(${JSON.stringify(`/overlay/${encodeURIComponent(login)}/events`)});
        es.onmessage = function (e) {
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === "scene") root.innerHTML = msg.html;
          } catch (err) {}
        };
      })();
    </script>
    ${whepClientScript(whepUrl)}`;
  return page({ title: "Compositor", body, transparent: false });
}

/**
 * @param {object} deps
 * @param {(login: string) => object | undefined} deps.getAccountByLogin
 * @param {string} deps.musicDir - directory audio files are stored under, per account subfolder
 * @param {(accountId: string, req: any, res: any) => void} deps.subscribeEvents
 * @param {(account: object) => object} deps.getMusicNow
 */
function createOverlayRouter({ getAccountByLogin, musicDir, isLiveFn, subscribeEvents, getMusicNow }) {
  const router = express.Router();

  function accountOr404(req, res) {
    const account = getAccountByLogin(req.params.login);
    if (!account) { res.status(404).send("not found"); return null; }
    return account;
  }

  router.get("/:login/starting-soon", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    const cfg = account.overlayConfig?.startingSoon || {};
    const fragment = withWidgets(startingSoonFragment(cfg, req.query), account.overlayConfig, req.params.login);
    res.send(page({ title: req.query.title || cfg.title || "Starting Soon", body: fragment, transparent: false }));
  });

  router.get("/:login/brb", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    const cfg = account.overlayConfig?.brb || {};
    const fragment = withWidgets(brbFragment(cfg, req.query), account.overlayConfig, req.params.login);
    res.send(page({ title: req.query.title || cfg.title || "BRB", body: fragment, transparent: false }));
  });

  router.get("/:login/ending", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    const cfg = account.overlayConfig?.ending || {};
    const fragment = withWidgets(endingFragment(cfg, req.query), account.overlayConfig, req.params.login);
    res.send(page({ title: req.query.title || cfg.title || "Thanks for watching", body: fragment, transparent: false }));
  });

  router.get("/:login/live", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    res.send(liveBadgePage(req.params.login, account.overlayConfig?.live || {}));
  });

  router.get("/:login/live-status.json", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    res.json({ live: isLiveFn(account) });
  });

  router.get("/:login/master", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    const fragment = withWidgets(resolveSceneFragment(account.currentScene, account), account.overlayConfig, req.params.login);
    res.send(masterPage(req.params.login, fragment));
  });

  // Loaded by the built-in compositor (dashboard/compositor.js) only -
  // not meant to be pasted into OBS (it plays this account's OWN output
  // back into itself, which would be a feedback loop with a real capture
  // engine wired in front of it).
  router.get("/:login/compositor", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    const fragment = withWidgets(resolveSceneFragment(account.currentScene, account), account.overlayConfig, req.params.login);
    res.send(compositorPage(req.params.login, fragment));
  });

  // SSE stream the master page (and, in principle, any future live widget)
  // subscribes to - see subscribeEvents in server.js for what publishes to it.
  router.get("/:login/events", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    subscribeEvents(account.twitchUserId, req, res);
  });

  router.get("/:login/custom/:slug", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    const overlay = (account.overlays || []).find((o) => o.slug === req.params.slug);
    if (!overlay) return res.status(404).send("not found");

    if (overlay.type === "text") {
      return res.send(page({ title: overlay.name, body: withWidgets(textOverlayFragment(overlay), account.overlayConfig, req.params.login) }));
    }
    if (overlay.type === "html") {
      return res.send(page({ title: overlay.name, body: withWidgets(htmlOverlayFragment(overlay), account.overlayConfig, req.params.login) }));
    }
    if (overlay.type === "music") return res.send(musicOverlayPage(req.params.login));
    res.status(400).send("unknown overlay type");
  });

  router.get("/:login/music/now.json", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    res.json(getMusicNow(account));
  });

  router.get("/:login/music/file/:trackId", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    const track = (account.musicTracks || []).find((t) => t.id === req.params.trackId);
    if (!track) return res.status(404).send("not found");
    const filePath = path.join(musicDir, account.twitchUserId, track.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send("not found");
    const ext = path.extname(track.filename).toLowerCase();
    res.setHeader("Content-Type", AUDIO_MIME[ext] || "application/octet-stream");
    res.sendFile(filePath);
  });

  return router;
}

module.exports = { createOverlayRouter, escapeHtml, resolveSceneFragment, withWidgets };
