const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const {
  escapeHtml, page, startingSoonFragment, brbFragment, endingFragment, offlineFragment, withWidgets,
} = require("./scenes");
const { musicSceneFragment } = require("./music-scene");

const PROFILE_STORE_SYSTEM = "restreamnode-profile-store-v1";
const AUDIO_MIME = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".oga": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac",
  ".opus": "audio/opus", ".weba": "audio/webm",
};

function safeEmbedUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return (url.protocol === "https:" || url.protocol === "http:") ? url.toString() : "";
  } catch {
    return "";
  }
}

function profileStoreForAccount(account) {
  return (account?.overlays || []).find(o => o?.config?.system === PROFILE_STORE_SYSTEM)?.config || null;
}

function activeProfileForAccount(account) {
  const store = profileStoreForAccount(account);
  if (!store || !Array.isArray(store.profiles)) return null;
  return store.profiles.find(p => p.id === store.activeProfileId) || store.profiles[0] || null;
}

function profileSceneMusicFrame(account, sceneName) {
  if (!["startingSoon", "brb", "ending"].includes(sceneName)) return "";
  const profile = activeProfileForAccount(account);
  if (!profile?.id || profile.mode === "music" || profile.sceneMusicEnabled !== true) return "";
  const layout = profile.canvasMode === "vertical" ? "vertical" : "landscape";
  const src = `/overlay/${encodeURIComponent(account.twitchLogin)}/music/${encodeURIComponent(profile.id)}?audioOnly=1&layout=${layout}`;
  return `<iframe class="cn-profile-scene-music" src="${escapeHtml(src)}" allow="autoplay" aria-hidden="true" tabindex="-1" style="position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;border:0;opacity:0;pointer-events:none"></iframe>`;
}

function liveBadgePage(login, cfg) {
  const accent = cfg.accent || "#35d07f";
  const body = `
    <div id="wrap" style="position:fixed; bottom:24px; right:24px; display:none; align-items:center; gap:10px; background:rgba(0,0,0,.55); padding:10px 18px; border-radius:999px; color:#fff; font-weight:700; font-size:16px; backdrop-filter:blur(10px); border:1px solid rgba(255,255,255,.10);">
      <span style="width:12px; height:12px; border-radius:50%; background:${escapeHtml(accent)}; box-shadow:0 0 10px ${escapeHtml(accent)}; animation:cs-pulse 1.4s infinite;"></span>
      <span id="label">${escapeHtml(cfg.title || "LIVE")}</span>
    </div>
    <style>@keyframes cs-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }</style>
    <script>
      (function () {
        function poll() {
          fetch(${JSON.stringify(`/overlay/${encodeURIComponent(login)}/live-status.json`)}, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (data) { var el=document.getElementById("wrap"); if(el)el.style.display = data.live ? "flex" : "none"; })
            .catch(function () {});
        }
        poll(); setInterval(poll, 2000);
      })();
    </script>`;
  return page({ title: cfg.title || "Live", body });
}

function textOverlayFragment(overlay) {
  const cfg = overlay.config || {};
  const align = ["left", "center", "right"].includes(cfg.align) ? cfg.align : "center";
  const x = Number.isFinite(Number(cfg.x)) ? Number(cfg.x) : 50;
  const y = Number.isFinite(Number(cfg.y)) ? Number(cfg.y) : 50;
  return `<div style="position:fixed;inset:0;pointer-events:none"><div style="position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);max-width:90vw;font-size:${Number(cfg.fontSize) || 48}px;font-weight:${Number(cfg.fontWeight) || 700};color:${escapeHtml(cfg.color || "#ffffff")};text-align:${align};text-shadow:0 2px 12px rgba(0,0,0,.7);white-space:pre-wrap">${escapeHtml(cfg.text || "")}</div></div>`;
}

function iframeOverlayFragment(overlay) {
  const cfg = overlay.config || {};
  const url = safeEmbedUrl(cfg.url);
  if (!url) return `<div style="position:fixed;inset:0;display:grid;place-items:center;color:#f87171;font:600 16px ui-monospace,monospace;background:rgba(5,6,10,.65)">Invalid iframe URL</div>`;
  const width = Math.max(0, Number(cfg.width) || 0);
  const height = Math.max(0, Number(cfg.height) || 0);
  const fullscreen = cfg.fullscreen !== false && !(width && height);
  const x = Math.max(0, Math.min(100, Number(cfg.x ?? 50)));
  const y = Math.max(0, Math.min(100, Number(cfg.y ?? 50)));
  const opacity = Math.max(0, Math.min(1, Number(cfg.opacity ?? 1)));
  const pointerEvents = cfg.interactive ? "auto" : "none";
  const bg = cfg.transparent === false ? (cfg.background || "#05060a") : "transparent";
  const frameStyle = fullscreen
    ? "position:absolute;inset:0;width:100%;height:100%;"
    : `position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);width:${width || 800}px;height:${height || 600}px;`;
  return `<div style="position:fixed;inset:0;overflow:hidden;background:${escapeHtml(bg)};pointer-events:${pointerEvents}"><iframe src="${escapeHtml(url)}" title="${escapeHtml(overlay.name || "Browser overlay")}" sandbox="allow-scripts allow-same-origin allow-presentation" allow="autoplay; encrypted-media; fullscreen" referrerpolicy="no-referrer-when-downgrade" style="${frameStyle}border:0;background:${escapeHtml(bg)};opacity:${opacity}"></iframe></div>`;
}

function htmlOverlayFragment(overlay) {
  const cfg = overlay.config || {};
  if (cfg.kind === "iframe" || cfg.kind === "browser") return iframeOverlayFragment(overlay);
  return `${cfg.css ? `<style>${cfg.css}</style>` : ""}${cfg.html || ""}`;
}

function musicOverlayPage(login, cfg = {}, account, query = {}, profileId = null) {
  const audioOnly = String(query.audioOnly || "") === "1";
  return page({
    title: query.title || cfg.title || "Music",
    body: musicSceneFragment(login, cfg, query, account, profileId),
    transparent: audioOnly,
  });
}

function resolveSceneFragment(scene, account) {
  const cfg = account.overlayConfig || {};
  if (!scene || scene.kind === "none") return "";
  if (scene.kind === "builtin") {
    let fragment = "";
    if (scene.name === "startingSoon") fragment = startingSoonFragment(cfg.startingSoon || {}, {}, account);
    else if (scene.name === "brb") fragment = brbFragment(cfg.brb || {}, {}, account);
    else if (scene.name === "ending") fragment = endingFragment(cfg.ending || {}, {}, account);
    else if (scene.name === "offline") fragment = offlineFragment(cfg.offline || {}, {}, account);
    else if (scene.name === "music") {
      const profile = activeProfileForAccount(account);
      return musicSceneFragment(account.twitchLogin, cfg.music || {}, { layout: profile?.canvasMode || "landscape" }, account, profile?.id || null);
    }
    return fragment ? fragment + profileSceneMusicFrame(account, scene.name) : "";
  }
  if (scene.kind === "custom") {
    const overlay = (account.overlays || []).find(o => o.id === scene.overlayId);
    if (!overlay || overlay.config?.system) return "";
    if (overlay.type === "text") return textOverlayFragment(overlay);
    if (overlay.type === "html") return htmlOverlayFragment(overlay);
    if (overlay.type === "music") {
      const profile = activeProfileForAccount(account);
      return musicSceneFragment(account.twitchLogin, overlay.config || {}, { layout: profile?.canvasMode || "landscape" }, account, profile?.id || null);
    }
  }
  return "";
}

function sceneMountScript(login) {
  return `<script>(function(){var root=document.getElementById("scene-root");function mount(html){root.innerHTML=html||"";Array.prototype.slice.call(root.querySelectorAll("script")).forEach(function(oldScript){var s=document.createElement("script");Array.prototype.slice.call(oldScript.attributes||[]).forEach(function(a){s.setAttribute(a.name,a.value)});s.textContent=oldScript.textContent||"";oldScript.parentNode.replaceChild(s,oldScript)})}window.__rnMountScene=mount;var initial=document.getElementById("scene-initial");mount(initial?initial.innerHTML:"");if(initial)initial.remove();var es=new EventSource(${JSON.stringify(`/overlay/${encodeURIComponent(login)}/events`)});es.onmessage=function(e){try{var msg=JSON.parse(e.data);if(msg.type==="scene")mount(msg.html)}catch(err){}}})();</script>`;
}

function masterPage(login, initialFragment) {
  const body = `<template id="scene-initial">${initialFragment}</template><div id="scene-root"></div>${sceneMountScript(login)}`;
  return page({ title: "Live scene", body, transparent: true });
}

function whepClientScript(whepUrl) {
  return `<script>(function(){function connectWhep(){var pc=new RTCPeerConnection();pc.addTransceiver("video",{direction:"recvonly"});pc.addTransceiver("audio",{direction:"recvonly"});var video=document.getElementById("bg-video");pc.ontrack=function(ev){if(video.srcObject!==ev.streams[0])video.srcObject=ev.streams[0]};pc.oniceconnectionstatechange=function(){if(pc.iceConnectionState==="failed"||pc.iceConnectionState==="disconnected"){try{pc.close()}catch(e){}setTimeout(connectWhep,3000)}};pc.createOffer().then(function(offer){return pc.setLocalDescription(offer)}).then(function(){return new Promise(function(resolve){if(pc.iceGatheringState==="complete")return resolve();pc.addEventListener("icegatheringstatechange",function onchange(){if(pc.iceGatheringState==="complete"){pc.removeEventListener("icegatheringstatechange",onchange);resolve()}})})}).then(function(){return fetch(${JSON.stringify(whepUrl)},{method:"POST",headers:{"Content-Type":"application/sdp"},body:pc.localDescription.sdp})}).then(function(res){if(!res.ok)throw new Error("WHEP offer rejected: "+res.status);return res.text()}).then(function(answer){return pc.setRemoteDescription({type:"answer",sdp:answer})}).catch(function(){try{pc.close()}catch(e){}setTimeout(connectWhep,3000)})}connectWhep()})();</script>`;
}

function compositorPage(login, initialFragment) {
  const whepUrl = "/" + ["webrtc", "public", login, "whep"].map(encodeURIComponent).join("/");
  const body = `<video id="bg-video" autoplay muted playsinline style="position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;background:#000"></video><template id="scene-initial">${initialFragment}</template><div id="scene-root" style="position:fixed;inset:0"></div>${sceneMountScript(login)}${whepClientScript(whepUrl)}`;
  return page({ title: "Compositor", body, transparent: false });
}

function createOverlayRouter({ getAccountByLogin, musicDir, isLiveFn, subscribeEvents, getMusicNow, getMusicState, getActiveProfile, musicFilePathFor }) {
  const router = express.Router();

  function accountOr404(req, res) {
    const account = getAccountByLogin(req.params.login);
    if (!account) { res.status(404).send("not found"); return null; }
    return account;
  }

  function profileIdOrActive(account, requested) {
    if (requested) return requested;
    return getActiveProfile?.(account)?.id || activeProfileForAccount(account)?.id || null;
  }

  function sceneWithMusic(fragment, account, sceneName) {
    return withWidgets(fragment + profileSceneMusicFrame(account, sceneName), account.overlayConfig, account.twitchLogin);
  }

  router.get("/:login/starting-soon", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const cfg = account.overlayConfig?.startingSoon || {};
    res.send(page({ title: req.query.title || cfg.title || "Starting Soon", body: sceneWithMusic(startingSoonFragment(cfg, req.query, account), account, "startingSoon"), transparent: false }));
  });
  router.get("/:login/brb", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const cfg = account.overlayConfig?.brb || {};
    res.send(page({ title: req.query.title || cfg.title || "BRB", body: sceneWithMusic(brbFragment(cfg, req.query, account), account, "brb"), transparent: false }));
  });
  router.get("/:login/ending", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const cfg = account.overlayConfig?.ending || {};
    res.send(page({ title: req.query.title || cfg.title || "Thanks for watching", body: sceneWithMusic(endingFragment(cfg, req.query, account), account, "ending"), transparent: false }));
  });
  router.get("/:login/offline", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const cfg = account.overlayConfig?.offline || {};
    res.send(page({ title: req.query.title || cfg.title || "Offline", body: withWidgets(offlineFragment(cfg, req.query, account), account.overlayConfig, req.params.login), transparent: false }));
  });

  router.get("/:login/music/:profileId/now.json", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const musicState = getMusicState?.(account, req.params.profileId);
    if (!musicState) return res.status(404).json({ error: "unknown profile" });
    res.json(getMusicNow(account, req.params.profileId));
  });
  router.get("/:login/music/:profileId/file/:trackId", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const musicState = getMusicState?.(account, req.params.profileId);
    if (!musicState || !musicState.tracks.some(t => t.id === req.params.trackId)) return res.status(404).send("not found");
    const filePath = musicFilePathFor?.(account, req.params.profileId, req.params.trackId);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("not found");
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", AUDIO_MIME[ext] || "application/octet-stream");
    res.sendFile(filePath);
  });
  router.get("/:login/music/now.json", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const profileId = profileIdOrActive(account, null);
    res.json(getMusicNow(account, profileId));
  });
  router.get("/:login/music/file/:trackId", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const profileId = profileIdOrActive(account, null);
    const musicState = getMusicState?.(account, profileId);
    if (!musicState || !musicState.tracks.some(t => t.id === req.params.trackId)) return res.status(404).send("not found");
    const filePath = musicFilePathFor?.(account, profileId, req.params.trackId) || (musicDir ? path.join(musicDir, account.twitchUserId, musicState.profileId || profileId, musicState.tracks.find(t => t.id === req.params.trackId).filename) : null);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("not found");
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", AUDIO_MIME[ext] || "application/octet-stream");
    res.sendFile(filePath);
  });
  router.get("/:login/music/:profileId", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const musicState = getMusicState?.(account, req.params.profileId);
    if (!musicState) return res.status(404).send("unknown profile");
    const cfg = account.overlayConfig?.music || {};
    res.send(musicOverlayPage(req.params.login, cfg, account, req.query, req.params.profileId));
  });
  router.get("/:login/music", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const profileId = profileIdOrActive(account, null);
    const cfg = account.overlayConfig?.music || {};
    res.send(musicOverlayPage(req.params.login, cfg, account, req.query, profileId));
  });

  router.get("/:login/live", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    res.send(liveBadgePage(req.params.login, account.overlayConfig?.live || {}));
  });
  router.get("/:login/live-status.json", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    res.json({ live: isLiveFn(account) });
  });
  router.get("/:login/master", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const fragment = withWidgets(resolveSceneFragment(account.currentScene, account), account.overlayConfig, req.params.login);
    res.send(masterPage(req.params.login, fragment));
  });
  router.get("/:login/compositor", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const fragment = withWidgets(resolveSceneFragment(account.currentScene, account), account.overlayConfig, req.params.login);
    res.send(compositorPage(req.params.login, fragment));
  });
  router.get("/:login/events", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    subscribeEvents(account.twitchUserId, req, res);
  });
  router.get("/:login/custom/:slug", (req, res) => {
    const account = accountOr404(req, res); if (!account) return;
    const overlay = (account.overlays || []).find(o => o.slug === req.params.slug && !o.config?.system);
    if (!overlay) return res.status(404).send("not found");
    if (overlay.type === "text") return res.send(page({ title: overlay.name, body: withWidgets(textOverlayFragment(overlay), account.overlayConfig, req.params.login) }));
    if (overlay.type === "html") return res.send(page({ title: overlay.name, body: withWidgets(htmlOverlayFragment(overlay), account.overlayConfig, req.params.login) }));
    if (overlay.type === "music") {
      const profile = getActiveProfile?.(account) || activeProfileForAccount(account);
      return res.send(musicOverlayPage(req.params.login, overlay.config || {}, account, { layout: profile?.canvasMode || "landscape" }, profile?.id || null));
    }
    res.status(400).send("unknown overlay type");
  });

  return router;
}

module.exports = { createOverlayRouter, escapeHtml, resolveSceneFragment, withWidgets };
