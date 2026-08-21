"use strict";

const PROFILE_STORE_SYSTEM = "restreamnode-profile-store-v1";
const PROFILE_COLORS = { pc: "#7c5cff", console: "#ff4fd8", music: "#38e8ff" };
const MODE_LABELS = { pc: "PC Streaming", console: "Console Streaming", music: "24/7 Music" };
const LAYOUT_LABELS = { landscape: "16:9 Landscape", vertical: "9:16 Vertical" };
const PAGE_TITLES = {
  overview: "Overview", sources: "Sources", destinations: "Destinations",
  studio: "Overlay Studio", music: "Music 24/7", profiles: "Profiles", settings: "Settings",
};

const S = {
  page: "overview",
  status: null,
  overlays: [],
  overlayConfig: {},
  tracks: [],
  musicSettings: { shuffle: false, loop: true, volume: .7 },
  scene: null,
  compositor: { enabled: false },
  profileStoreOverlay: null,
  profiles: [],
  activeProfileId: null,
  pollTimer: null,
  musicNowTimer: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function api(url, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  let data = null;
  const type = res.headers.get("content-type") || "";
  try { data = type.includes("json") ? await res.json() : await res.text(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || (typeof data === "string" && data) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, type = "") {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function setView(id) {
  for (const view of ["login-view", "setup-view", "streamkey-view", "app-view"]) {
    $("#" + view)?.classList.toggle("hidden", view !== id);
  }
}

function activeProfile() {
  return S.profiles.find(p => p.id === S.activeProfileId) || null;
}

function modeSource(mode) {
  return mode === "console" ? "console" : "pc";
}

function musicApiUrl(endpoint, profileId = S.activeProfileId) {
  const suffix = String(endpoint || "");
  if (!profileId) return `/api/music${suffix}`;
  return `/api/music${suffix}${suffix.includes("?") ? "&" : "?"}profileId=${encodeURIComponent(profileId)}`;
}

function createProfile(mode, name) {
  return {
    id: uuid(),
    name: name || MODE_LABELS[mode] || "Profile",
    mode,
    color: PROFILE_COLORS[mode] || "#7c5cff",
    canvasMode: "landscape",
    sceneMusicEnabled: mode === "music",
    scene: S.scene || null,
    compositorEnabled: mode === "music" ? false : true,
    musicAutostart: mode === "music",
    musicSettings: { ...S.musicSettings },
    musicVisual: {
      accent: mode === "music" ? "#00f0ff" : PROFILE_COLORS[mode],
      background: "",
      station: S.status?.displayName ? `${S.status.displayName} Radio` : "CastNexus Radio",
      title: "CastNexus Radio",
      cover: S.status?.profileImageUrl || "",
    },
    createdAt: new Date().toISOString(),
  };
}

function normaliseProfiles() {
  let dirty = false;
  for (const p of S.profiles) {
    if (!p.canvasMode || !["landscape", "vertical"].includes(p.canvasMode)) { p.canvasMode = "landscape"; dirty = true; }
    if (p.sceneMusicEnabled === undefined) { p.sceneMusicEnabled = p.mode === "music"; dirty = true; }
    if (!p.musicSettings) { p.musicSettings = { shuffle:false, loop:true, volume:.7 }; dirty = true; }
    if (p.destinationEnabledIds !== undefined) { delete p.destinationEnabledIds; dirty = true; }
  }
  return dirty;
}

async function fetchCore() {
  const [status, overlaysData, overlayConfig, sceneData, compositor] = await Promise.all([
    api("/api/status"),
    api("/api/overlays"),
    api("/api/overlays/config"),
    api("/api/scenes/current"),
    api("/api/compositor"),
  ]);
  S.status = status;
  S.overlays = overlaysData.overlays || [];
  S.overlayConfig = overlayConfig || {};
  S.scene = sceneData.currentScene || null;
  S.compositor = compositor || { enabled:false };
  loadProfileStoreFromOverlays();

  const profileId = S.activeProfileId;
  const [tracksData, musicSettings] = await Promise.all([
    api(musicApiUrl("/tracks", profileId)),
    api(musicApiUrl("/settings", profileId)),
  ]);
  S.tracks = tracksData.tracks || [];
  S.musicSettings = musicSettings || { shuffle:false, loop:true, volume:.7 };
  const p = activeProfile();
  if (p) p.musicSettings = { ...S.musicSettings };
}

function loadProfileStoreFromOverlays() {
  S.profileStoreOverlay = S.overlays.find(o => o?.config?.system === PROFILE_STORE_SYSTEM) || null;
  const cfg = S.profileStoreOverlay?.config || {};
  S.profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  S.activeProfileId = cfg.activeProfileId || S.profiles[0]?.id || null;
  normaliseProfiles();
}

async function ensureProfileStore(initialMode) {
  if (!S.overlays.length) {
    try { S.overlays = (await api("/api/overlays")).overlays || []; } catch {}
  }
  loadProfileStoreFromOverlays();
  if (S.profileStoreOverlay && S.profiles.length) {
    if (normaliseProfiles()) await saveProfileStore();
    return;
  }

  const mode = initialMode || (S.status?.sourceMode === "console" ? "console" : "pc");
  const profile = createProfile(mode, mode === "pc" ? "PC Gaming" : mode === "console" ? "Console Gaming" : "24/7 Music");
  const payload = {
    name: "CastNexus Profiles",
    type: "html",
    config: {
      system: PROFILE_STORE_SYSTEM,
      html: "",
      profiles: [profile],
      activeProfileId: profile.id,
      version: 2,
    },
  };
  const created = await api("/api/overlays", { method:"POST", body:payload });
  S.profileStoreOverlay = created.overlay;
  S.profiles = [profile];
  S.activeProfileId = profile.id;
  S.overlays.push(created.overlay);
}

async function saveProfileStore() {
  if (!S.profileStoreOverlay) return;
  const config = {
    ...(S.profileStoreOverlay.config || {}),
    system: PROFILE_STORE_SYSTEM,
    html: "",
    profiles: S.profiles,
    activeProfileId: S.activeProfileId,
    version: 2,
    updatedAt: new Date().toISOString(),
  };
  const r = await api(`/api/overlays/${encodeURIComponent(S.profileStoreOverlay.id)}`, {
    method: "PUT", body: { config },
  });
  S.profileStoreOverlay = r.overlay;
  const i = S.overlays.findIndex(o => o.id === r.overlay.id);
  if (i >= 0) S.overlays[i] = r.overlay;
}

async function snapshotActiveProfile(showToast = false) {
  const p = activeProfile();
  if (!p) return;
  const [sceneData, compositor, musicSettings] = await Promise.all([
    api("/api/scenes/current"), api("/api/compositor"), api(musicApiUrl("/settings", p.id)),
  ]);
  p.scene = sceneData.currentScene || null;
  p.compositorEnabled = !!compositor.enabled;
  p.musicSettings = { ...musicSettings };
  await saveProfileStore();
  if (showToast) toast("Profile state saved", "success");
}

async function activateProfile(profileId) {
  const target = S.profiles.find(p => p.id === profileId);
  if (!target || target.id === S.activeProfileId) return;
  const previous = activeProfile();

  try {
    await snapshotActiveProfile(false);

    // A rerun is a profile-owned program source. Never let Profile A's
    // Twitch/VOD relay continue driving output after the user switches to B.
    try {
      const rerun = await api("/api/vod/status");
      if (rerun?.state && rerun.state !== "idle") {
        await api("/api/vod/stop", { method:"POST" });
        await sleep(350);
      }
    } catch {}

    // When leaving a 24/7 profile, publish the new active id first so the
    // embedded worker stops the old profile before another source is selected.
    if (previous?.mode === "music" && target.mode !== "music") {
      S.activeProfileId = target.id;
      await saveProfileStore();
      await sleep(350);
    }

    await api("/api/source-mode", { method:"POST", body:{ sourceMode: modeSource(target.mode) } });

    // The server now exposes the target profile's own destination list as soon
    // as activeProfileId changes. No global destination toggle replay is needed.
    if (!(previous?.mode === "music" && target.mode !== "music")) {
      S.activeProfileId = target.id;
      await saveProfileStore();
    }

    const compositorWanted = target.mode === "music" ? false : !!target.compositorEnabled;
    await api("/api/compositor", { method:"POST", body:{ enabled:compositorWanted } });

    if (target.mode !== "music") {
      const scene = target.scene || { kind:"none" };
      try { await api("/api/scenes/current", { method:"POST", body:scene }); } catch {}
    }

    await fetchCore();
    updateChrome();
    renderProfileSelect();

    if (S.status.needsStreamKey) {
      setView("streamkey-view");
      toast("Console profile needs a Twitch stream key", "error");
      return;
    }

    renderPage();
    toast(`Switched to ${target.name}`, "success");
  } catch (err) {
    toast(err.message, "error");
    await fetchCore().catch(() => {});
    renderProfileSelect();
  }
}
