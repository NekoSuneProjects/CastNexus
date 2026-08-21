// Profile-scoped RTMP credentials and source cards.
(function(){
  "use strict";

  function newRtmpKey() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return [...bytes].map(v => v.toString(16).padStart(2,"0")).join("");
  }
  function validKey(value) { return /^[A-Za-z0-9_-]{20,128}$/.test(String(value || "")); }
  function ensureLocalRtmpKeys() {
    let dirty = false;
    for (const profile of S.profiles || []) {
      if (validKey(profile.rtmpKey)) continue;
      profile.rtmpKey = newRtmpKey();
      dirty = true;
    }
    return dirty;
  }

  const originalCreateProfile = window.createProfile;
  window.createProfile = function(mode, name) {
    const profile = originalCreateProfile(mode, name);
    if (!validKey(profile.rtmpKey)) profile.rtmpKey = newRtmpKey();
    return profile;
  };

  const originalLoadProfileStore = window.loadProfileStoreFromOverlays;
  window.loadProfileStoreFromOverlays = function() {
    originalLoadProfileStore();
    ensureLocalRtmpKeys();
  };

  // Keep the server-returned profile objects so a key generated/migrated by
  // the backend can never be lost by a later profile save.
  window.saveProfileStore = async function saveProfileStore() {
    if (!S.profileStoreOverlay) return;
    ensureLocalRtmpKeys();
    const config = {
      ...(S.profileStoreOverlay.config || {}),
      system: PROFILE_STORE_SYSTEM,
      html: "",
      profiles: S.profiles,
      activeProfileId: S.activeProfileId,
      version: 3,
      updatedAt: new Date().toISOString(),
    };
    const r = await api(`/api/overlays/${encodeURIComponent(S.profileStoreOverlay.id)}`, { method:"PUT", body:{ config } });
    S.profileStoreOverlay = r.overlay;
    if (Array.isArray(r.overlay?.config?.profiles)) {
      S.profiles = r.overlay.config.profiles;
      S.activeProfileId = r.overlay.config.activeProfileId || S.activeProfileId;
    }
    const i = S.overlays.findIndex(o => o.id === r.overlay.id);
    if (i >= 0) S.overlays[i] = r.overlay;
  };

  window.renderPcSourceSetup = function renderPcSourceSetup() {
    const p = activeProfile();
    const rtmp = S.status?.profileRtmp || {};
    const live = !!S.status?.sources?.pc?.live;
    return `<section class="grid grid-2">
      <div class="card-panel">
        <div class="card-title-row"><h3>${esc(p?.name || "PC profile")} · RTMP ingest</h3><span class="badge ${live ? "green" : ""}">${live ? "CONNECTED" : "WAITING"}</span></div>
        <p>This RTMP route belongs only to <strong>${esc(p?.name || "this profile")}</strong>. Another profile can stay connected without becoming the active program.</p>
        <label>Profile RTMP server</label>
        <div class="copy-field"><input readonly value="${esc(rtmp.server || S.status?.pcServer || "")}"><button class="btn btn-ghost btn-sm" data-copy="${esc(rtmp.server || S.status?.pcServer || "")}">Copy</button></div>
        <label>Profile stream key</label>
        <div class="copy-field"><input readonly value="${esc(rtmp.key || S.status?.pcKey || "")}"><button class="btn btn-ghost btn-sm" data-copy="${esc(rtmp.key || S.status?.pcKey || "")}">Copy</button></div>
        <div class="callout" style="margin-top:12px"><strong>Full MediaMTX path:</strong> <code>${esc(rtmp.path || "Waiting for profile key")}</code></div>
      </div>
      <div class="card-panel">
        <h3>Profile isolation</h3>
        <p>Use these values in OBS → Settings → Stream → Custom. CastNexus selects output by active profile, not by whichever encoder connected first.</p>
        <div class="callout">You can leave another PC profile's OBS connected. Switching profiles moves CastNexus to the selected profile's path while the other feed stays in standby.</div>
        <button class="btn btn-danger btn-sm" data-action="regen-pc-key" style="margin-top:12px">Regenerate this profile key</button>
      </div>
    </section>`;
  };

  window.renderMusicSourceSetup = function renderMusicSourceSetup() {
    const p = activeProfile();
    const rtmp = S.status?.profileRtmp || {};
    const live = !!S.status?.sources?.music?.live && S.status?.activeProfileId === p?.id;
    const hasTracks = S.tracks.length > 0;
    return `<section class="grid grid-2">
      <div class="card-panel">
        <div class="card-title-row"><h3>Music 24/7 profile publisher</h3><span class="badge ${live ? "green" : hasTracks ? "cyan" : ""}">${live ? "ON AIR" : hasTracks ? "STARTING / WAITING" : "NEEDS MUSIC"}</span></div>
        <p>The <code>music24</code> worker renders ${p?.canvasMode === "vertical" ? "9:16" : "16:9"}, mixes this profile's isolated library, and publishes to this profile's own MediaMTX route.</p>
        <div class="callout"><strong>Publisher path:</strong> <code>${esc(rtmp.path || "Waiting for profile key")}</code><br><strong>Program state:</strong> ${esc(S.status?.activeSource || "idle")}</div>
      </div>
      <div class="card-panel">
        <h3>Music readiness</h3>
        <p>${hasTracks ? `${S.tracks.length} track${S.tracks.length === 1 ? "" : "s"} in ${esc(p?.name || "this profile")}. The worker verifies MediaMTX input and output readiness before reporting ON AIR.` : "Upload at least one audio file before the Music 24/7 publisher can start."}</p>
        <button class="btn btn-primary btn-sm" data-nav="music">Open profile music</button>
      </div>
    </section>`;
  };
})();
