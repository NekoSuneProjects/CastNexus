// CastNexus Music control-room artwork + now-playing synchronisation.
// Loaded after app-runtime.js so these implementations replace the older
// music-note-only renderers without disturbing the rest of the Studio runtime.
(function(){
  "use strict";

  function profileFallbackCover() {
    const p = activeProfile();
    return String(p?.musicVisual?.cover || S.status?.profileImageUrl || "").trim();
  }

  function publicCoverUrl(track, profile = activeProfile()) {
    if (!track?.id || !profile?.id || !S.status?.twitchLogin) return "";
    return `/overlay/${encodeURIComponent(S.status.twitchLogin)}/music/${encodeURIComponent(profile.id)}/cover/${encodeURIComponent(track.id)}`;
  }

  function imageLayer(url, className) {
    if (!url) return "";
    return `<img class="${className}" src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">`;
  }

  function artworkInner(track, { localAvailable = null } = {}) {
    const fallback = profileFallbackCover();
    const local = localAvailable === false ? "" : publicCoverUrl(track);
    return `<span class="music-art-note" aria-hidden="true">♫</span>${imageLayer(fallback,"music-art-image music-art-fallback")}${imageLayer(local,"music-art-image music-art-primary")}`;
  }

  function artworkTile(track, className, options = {}) {
    return `<div class="${className} music-art-tile" data-track-cover="${esc(track?.id || "")}">${artworkInner(track, options)}</div>`;
  }

  window.trackRow = function trackRow(t) {
    return `<div class="list-row track-item" data-track-id="${esc(t.id)}">${artworkTile(t,"track-icon",{localAvailable:Boolean(t.coverFilename)})}<div class="item-main"><strong>${esc(t.title || "Untitled")}</strong><span>${esc(t.artist || "Unknown artist")} · ${fmtDuration(t.durationS)}</span></div><span class="badge">${Math.max(0,Math.round((t.sizeBytes||0)/1024/1024*10)/10)} MB</span><div class="item-actions"><button class="icon-button" data-edit-track="${esc(t.id)}">✎</button><button class="icon-button" data-delete-track="${esc(t.id)}">×</button></div></div>`;
  };

  function updateLibraryArtwork(tracks) {
    if (!Array.isArray(tracks)) return;
    for (const track of tracks) {
      const slot = document.querySelector(`[data-track-cover="${CSS.escape(String(track.id))}"]`);
      if (!slot) continue;
      const hadLocal = slot.querySelector(".music-art-primary");
      if (track.coverFilename && !hadLocal) slot.innerHTML = artworkInner(track,{localAvailable:true});
    }
  }

  window.startMusicNowPolling = function startMusicNowPolling() {
    stopMusicNowPolling();
    let libraryTick = 0;
    const tick = async () => {
      if (S.page !== "music" || !S.status?.twitchLogin) return;
      const p = activeProfile();
      try {
        const profilePart = p?.id ? `/${encodeURIComponent(p.id)}` : "";
        const now = await api(`/overlay/${encodeURIComponent(S.status.twitchLogin)}/music${profilePart}/now.json`);
        const card = $("#music-now-card"), badge = $("#music-now-mode");
        if (!card || !badge) return;

        if (now?.mode !== "playing" || !now.track) {
          badge.textContent = "IDLE";
          badge.className = "badge";
          card.innerHTML = `${artworkTile(null,"music-cover",{localAvailable:false})}<div class="music-now-copy"><strong>No track playing</strong><div class="muted music-now-artist">Waiting for this profile's music engine.</div><div class="progress"><span style="width:0"></span></div><div class="stat-sub">00:00 / 00:00</div></div>`;
        } else {
          badge.textContent = "PLAYING";
          badge.className = "badge green";
          const pct = now.durationS ? Math.max(0,Math.min(100,Number(now.positionS||0)/Number(now.durationS)*100)) : 0;
          const localAvailable = Boolean(now.track.coverEmbedded || now.track.coverSource);
          card.innerHTML = `${artworkTile(now.track,"music-cover",{localAvailable})}<div class="music-now-copy"><strong>${esc(now.track.title||"Untitled")}</strong><div class="muted music-now-artist">${esc(now.track.artist||"Unknown artist")}</div><div class="progress"><span style="width:${pct}%"></span></div><div class="stat-sub">${fmtDuration(now.positionS)} / ${fmtDuration(now.durationS)}</div></div>`;
        }

        // Remote artwork resolution is asynchronous. Refresh just the track
        // metadata occasionally and upgrade thumbnail slots in place instead
        // of re-rendering the whole page/iframe and interrupting the preview.
        libraryTick++;
        if (libraryTick % 5 === 0 && p?.id) {
          try {
            const latest = await api(musicApiUrl("/tracks",p.id));
            if (Array.isArray(latest?.tracks)) {
              S.tracks = latest.tracks;
              updateLibraryArtwork(S.tracks);
            }
          } catch {}
        }
      } catch {}
    };
    tick();
    S.musicNowTimer = setInterval(tick,1000);
  };

  const style = document.createElement("style");
  style.textContent = `
    .music-art-tile{position:relative;overflow:hidden;isolation:isolate;background:linear-gradient(145deg,rgba(124,92,255,.15),rgba(56,232,255,.08));}
    .music-art-note{position:absolute;inset:0;display:grid;place-items:center;z-index:0;color:#d7d0ff;font-size:1.1rem;background:linear-gradient(145deg,rgba(124,92,255,.12),rgba(56,232,255,.06));}
    .music-art-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;display:block;}
    .music-art-fallback{z-index:1;}
    .music-art-primary{z-index:2;}
    .track-icon.music-art-tile{padding:0;color:transparent;}
    .music-now-large .music-cover.music-art-tile{height:88px;flex:0 0 88px;padding:0;}
    @media(max-width:540px){.music-now-large .music-cover.music-art-tile{height:68px;flex-basis:68px;}}
  `;
  document.head.appendChild(style);
})();
