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

function standbyScene({ title, subtitle, accent, backgroundUrl, extra }) {
  const bg = backgroundUrl
    ? `background: linear-gradient(rgba(2,3,6,.55), rgba(2,3,6,.55)), url('${escapeHtml(backgroundUrl)}') center/cover no-repeat, #05060a;`
    : `background: radial-gradient(circle at 50% 42%, ${escapeHtml(accent)}22, #05060a 70%);`;
  const body = `
    <div style="${bg} width:100vw; height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#fff; text-align:center;">
      <div style="font-size:64px; font-weight:800; letter-spacing:.02em; text-shadow:0 0 30px ${escapeHtml(accent)}aa;">${escapeHtml(title)}</div>
      ${subtitle ? `<div style="margin-top:14px; font-size:24px; color:#c8ccd6;">${escapeHtml(subtitle)}</div>` : ""}
      ${extra || ""}
    </div>`;
  return page({ title, body, transparent: false });
}

function startingSoonPage(cfg, query) {
  const title = query.title || cfg.title || "Starting Soon";
  const subtitle = query.subtitle || cfg.subtitle || "";
  const accent = query.accent || cfg.accent || "#7c5cff";
  const backgroundUrl = query.background || cfg.backgroundUrl || "";
  const extra = countdownBlock(query.at || cfg.countdownAt, cfg.countdownLabel);
  return standbyScene({ title, subtitle, accent, backgroundUrl, extra });
}

function brbPage(cfg, query) {
  return standbyScene({
    title: query.title || cfg.title || "BRB",
    subtitle: query.subtitle || cfg.subtitle || "Be right back",
    accent: query.accent || cfg.accent || "#8a2bff",
    backgroundUrl: query.background || cfg.backgroundUrl || "",
  });
}

function endingPage(cfg, query) {
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
  return standbyScene({
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

function textOverlayPage(overlay) {
  const cfg = overlay.config || {};
  const body = `
    <div style="position:fixed; inset:0; display:flex; align-items:center; justify-content:center;">
      <div style="font-size:${Number(cfg.fontSize) || 48}px; color:${escapeHtml(cfg.color || "#ffffff")}; text-align:center; text-shadow:0 2px 12px rgba(0,0,0,.6); white-space:pre-wrap;">${escapeHtml(cfg.text || "")}</div>
    </div>`;
  return page({ title: overlay.name, body });
}

function htmlOverlayPage(overlay) {
  const cfg = overlay.config || {};
  // Deliberately NOT escaped - this is the explicit "raw HTML" escape hatch,
  // same tradeoff CacheStream's raw_html template accepts: you're trusted
  // with your own overlay, but a typo here breaks the broadcast, not anyone
  // else's.
  return page({ title: overlay.name, body: cfg.html || "", bodyCss: cfg.css || "" });
}

function musicOverlayPage(login, overlay, tracks) {
  const cfg = overlay.config || {};
  const playlist = tracks.map((t) => ({
    id: t.id,
    title: t.title || "Untitled",
    artist: t.artist || "",
    url: `/overlay/${encodeURIComponent(login)}/music/file/${t.id}`,
  }));
  const volume = Math.min(1, Math.max(0, Number(cfg.volume) || 0.7));
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
        var list = ${JSON.stringify(playlist)};
        if (!list.length) return;
        var order = list.map(function (_, i) { return i; });
        ${cfg.shuffle ? "order.sort(function () { return Math.random() - 0.5; });" : ""}
        var idx = 0;
        var audio = document.getElementById("player");
        var card = document.getElementById("card");
        audio.volume = ${volume};
        function playCurrent() {
          var track = list[order[idx]];
          audio.src = track.url;
          audio.play().catch(function () {});
          document.getElementById("t").textContent = track.title;
          document.getElementById("a").textContent = track.artist;
          card.style.opacity = "1";
        }
        audio.addEventListener("ended", function () {
          idx = (idx + 1) % order.length;
          playCurrent();
        });
        playCurrent();
      })();
    </script>`;
  return page({ title: overlay.name, body });
}

/**
 * @param {object} deps
 * @param {(login: string) => object | undefined} deps.getAccountByLogin
 * @param {string} deps.musicDir - directory audio files are stored under, per account subfolder
 */
function createOverlayRouter({ getAccountByLogin, musicDir, isLiveFn }) {
  const router = express.Router();

  function accountOr404(req, res) {
    const account = getAccountByLogin(req.params.login);
    if (!account) { res.status(404).send("not found"); return null; }
    return account;
  }

  router.get("/:login/starting-soon", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    res.send(startingSoonPage(account.overlayConfig?.startingSoon || {}, req.query));
  });

  router.get("/:login/brb", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    res.send(brbPage(account.overlayConfig?.brb || {}, req.query));
  });

  router.get("/:login/ending", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    res.send(endingPage(account.overlayConfig?.ending || {}, req.query));
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

  router.get("/:login/custom/:slug", (req, res) => {
    const account = accountOr404(req, res);
    if (!account) return;
    const overlay = (account.overlays || []).find((o) => o.slug === req.params.slug);
    if (!overlay) return res.status(404).send("not found");

    if (overlay.type === "text") return res.send(textOverlayPage(overlay));
    if (overlay.type === "html") return res.send(htmlOverlayPage(overlay));
    if (overlay.type === "music") {
      return res.send(musicOverlayPage(req.params.login, overlay, account.musicTracks || []));
    }
    res.status(400).send("unknown overlay type");
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

module.exports = { createOverlayRouter, escapeHtml };
