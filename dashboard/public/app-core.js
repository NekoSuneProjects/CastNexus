"use strict";

const PROFILE_STORE_SYSTEM = "restreamnode-profile-store-v1";
const PROFILE_COLORS = { pc: "#7c5cff", console: "#ff4fd8", music: "#38e8ff" };
const MODE_LABELS = { pc: "PC Streaming", console: "Console Streaming", music: "24/7 Music" };
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

function createProfile(mode, name) {
  const enabledIds = (S.status?.destinations || []).filter(d => d.enabled).map(d => d.id);
  return {
    id: uuid(),
    name: name || MODE_LABELS[mode] || "Profile",
    mode,
    color: PROFILE_COLORS[mode] || "#7c5cff",
    scene: S.scene || null,
    destinationEnabledIds: enabledIds,
    compositorEnabled: mode === "music" ? false : true,
    musicAutostart: mode === "music",
    musicSettings: { ...S.musicSettings },
    musicVisual: {
      accent: mode === "music" ? "#00f0ff" : PROFILE_COLORS[mode],
      background: "",
      station: S.status?.displayName ? `${S.status.displayName} Radio` : "RestreamNode Radio",
      title: "RestreamNode Radio",
      cover: S.status?.profileImageUrl || "",
    },
    createdAt: new Date().toISOString(),
  };
}

async function fetchCore() {
  const [status, overlaysData, overlayConfig, tracksData, musicSettings, sceneData, compositor] = await Promise.all([
    api("/api/status"),
    api("/api/overlays"),
    api("/api/overlays/config"),
    api("/api/music/tracks"),
    api("/api/music/settings"),
    api("/api/scenes/current"),
    api("/api/compositor"),
  ]);
  S.status = status;
  S.overlays = overlaysData.overlays || [];
  S.overlayConfig = overlayConfig || {};
  S.tracks = tracksData.tracks || [];
  S.musicSettings = musicSettings || { shuffle:false, loop:true, volume:.7 };
  S.scene = sceneData.currentScene || null;
  S.compositor = compositor || { enabled:false };
  loadProfileStoreFromOverlays();
}

function loadProfileStoreFromOverlays() {
  S.profileStoreOverlay = S.overlays.find(o => o?.config?.system === PROFILE_STORE_SYSTEM) || null;
  const cfg = S.profileStoreOverlay?.config || {};
  S.profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  S.activeProfileId = cfg.activeProfileId || S.profiles[0]?.id || null;
}

async function ensureProfileStore(initialMode) {
  if (!S.overlays.length) {
    try { S.overlays = (await api("/api/overlays")).overlays || []; } catch {}
  }
  loadProfileStoreFromOverlays();
  if (S.profileStoreOverlay && S.profiles.length) return;

  const mode = initialMode || (S.status?.sourceMode === "console" ? "console" : "pc");
  const profile = createProfile(mode, mode === "pc" ? "PC Gaming" : mode === "console" ? "Console Gaming" : "24/7 Music");
  const payload = {
    name: "RestreamNode Profiles",
    type: "html",
    config: {
      system: PROFILE_STORE_SYSTEM,
      html: "",
      profiles: [profile],
      activeProfileId: profile.id,
      version: 1,
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
    version: 1,
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
  const [status, sceneData, compositor, musicSettings] = await Promise.all([
    api("/api/status"), api("/api/scenes/current"), api("/api/compositor"), api("/api/music/settings"),
  ]);
  p.destinationEnabledIds = (status.destinations || []).filter(d => d.enabled).map(d => d.id);
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

    // Stop 24/7 music first when leaving it. The sidecar watches this store
    // and tears down its generated RTMP source within its short poll window.
    if (previous?.mode === "music" && target.mode !== "music") {
      S.activeProfileId = target.id;
      await saveProfileStore();
      await sleep(350);
    }

    await api("/api/source-mode", { method:"POST", body:{ sourceMode: modeSource(target.mode) } });

    if (target.musicSettings) {
      await api("/api/music/settings", { method:"POST", body:target.musicSettings });
    }

    const status = await api("/api/status");
    for (const dest of status.destinations || []) {
      const wanted = (target.destinationEnabledIds || []).includes(dest.id);
      if (wanted !== !!dest.enabled) {
        await api(`/api/destinations/${encodeURIComponent(dest.id)}/toggle`, { method:"POST", body:{ enabled:wanted } });
      }
    }

    const compositorWanted = target.mode === "music" ? false : !!target.compositorEnabled;
    await api("/api/compositor", { method:"POST", body:{ enabled:compositorWanted } });

    if (target.mode !== "music") {
      const scene = target.scene || { kind:"none" };
      try { await api("/api/scenes/current", { method:"POST", body:scene }); } catch {}
    }

    // Starting a music profile is the inverse: source-mode/settings must be
    // ready before the sidecar sees the active profile and begins publishing.
    if (!(previous?.mode === "music" && target.mode !== "music")) {
      S.activeProfileId = target.id;
      await saveProfileStore();
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
