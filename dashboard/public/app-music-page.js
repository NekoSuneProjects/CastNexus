// Dedicated CastNexus Music 24/7 page.
// Loaded after app-pages-b.js so this specialized control-room layout replaces
// the generic two-card renderer while keeping the same IDs/events expected by
// app-runtime.js.

window.renderMusic = function renderMusic() {
  const p = activeProfile();
  const visual = p?.musicVisual || {};
  const musicProfile = p?.mode === "music";
  const onAir = musicProfile && S.status?.live;
  const programUrl = profileMusicUrl(p);
  const trackCount = S.tracks.length;
  const volume = Math.round((S.musicSettings.volume ?? .7) * 100);

  return `
    ${pageHead(
      "AUDIO AUTOMATION",
      "Music 24/7",
      "A proper always-on radio control room: monitor the program, manage playback, style the scene and let Docker keep it broadcasting.",
      `<label class="btn btn-primary music-upload-button" style="margin:0"><input id="music-file-input" type="file" accept="audio/*" multiple hidden>＋ Upload music</label>`
    )}

    <section class="music-studio-shell">
      <div class="card-panel music-program-card">
        <div class="music-card-heading">
          <div>
            <div class="eyebrow">PROGRAM MONITOR</div>
            <h3>CastNexus Radio</h3>
            <p>The monitor below is the same 16:9 scene rendered by the 24/7 Docker broadcaster.</p>
          </div>
          <div class="music-status-cluster">
            <span class="badge ${onAir ? "green" : "cyan"}">${onAir ? "● ON AIR" : musicProfile ? "24/7 PROFILE ACTIVE" : "PREVIEW MODE"}</span>
            <span class="badge">${trackCount} TRACK${trackCount === 1 ? "" : "S"}</span>
          </div>
        </div>

        <div class="music-program-layout">
          <div class="music-monitor-column">
            <div class="music-monitor-frame">
              <div class="music-monitor-topline">
                <span><i class="music-monitor-dot ${onAir ? "live" : ""}"></i>${onAir ? "LIVE PROGRAM" : "PROGRAM PREVIEW"}</span>
                <span>16:9 · 30 FPS</span>
              </div>
              <div class="music-monitor-screen">
                <iframe src="${esc(programUrl)}" allow="autoplay; fullscreen" title="CastNexus music program preview"></iframe>
              </div>
            </div>

            <div class="music-monitor-toolbar">
              <div class="music-monitor-facts">
                <span><strong>Renderer</strong> Chromium + FFmpeg</span>
                <span><strong>Spectrum</strong> Web Audio · 48 bands</span>
                <span><strong>Mode</strong> ${musicProfile ? "Automatic 24/7" : "Preview only"}</span>
              </div>
              <div class="page-actions">
                <button class="btn btn-ghost btn-sm" data-copy="${esc(programUrl)}">Copy scene URL</button>
                <button class="btn btn-ghost btn-sm" data-open-url="${esc(programUrl)}">Open full scene ↗</button>
              </div>
            </div>
          </div>

          <aside class="music-side-stack">
            <section class="music-side-panel music-now-panel">
              <div class="card-title-row">
                <div>
                  <div class="eyebrow">CURRENT TRACK</div>
                  <h3>Now playing</h3>
                </div>
                <span id="music-now-mode" class="badge">SYNCING</span>
              </div>
              <div id="music-now-card" class="music-now music-now-large">
                <div class="music-cover">♫</div>
                <div class="music-now-copy">
                  <strong>Waiting for music engine…</strong>
                  <div class="muted music-now-artist">—</div>
                  <div class="progress"><span></span></div>
                  <div class="stat-sub">00:00 / 00:00</div>
                </div>
              </div>
            </section>

            <section class="music-side-panel music-playback-panel">
              <div class="card-title-row">
                <div>
                  <div class="eyebrow">AUTOMATION</div>
                  <h3>Playback</h3>
                </div>
                <span class="badge purple">${volume}%</span>
              </div>

              <div class="music-toggle-grid">
                <label class="music-option">
                  <input id="music-shuffle" type="checkbox" ${S.musicSettings.shuffle ? "checked" : ""}>
                  <span class="music-option-icon">⤨</span>
                  <span><strong>Shuffle</strong><small>Randomise the library order</small></span>
                </label>
                <label class="music-option">
                  <input id="music-loop" type="checkbox" ${S.musicSettings.loop ? "checked" : ""}>
                  <span class="music-option-icon">↻</span>
                  <span><strong>Loop forever</strong><small>Keep the station running continuously</small></span>
                </label>
              </div>

              <div class="music-volume-control">
                <div class="music-volume-label-row">
                  <label for="music-volume">Master volume</label>
                  <strong id="music-volume-label">${volume}%</strong>
                </div>
                <input id="music-volume" type="range" min="0" max="1" step="0.01" value="${Number(S.musicSettings.volume ?? .7)}">
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>

    <section class="music-settings-grid">
      <div class="card-panel music-appearance-card">
        <div class="music-card-heading compact">
          <div>
            <div class="eyebrow">SCENE DESIGN</div>
            <h3>Radio appearance</h3>
            <p>Saved to this profile and reloaded automatically by the 24/7 renderer.</p>
          </div>
          <span class="badge cyan">PROFILE VISUALS</span>
        </div>

        <div class="music-appearance-grid">
          <div class="music-accent-field">
            <label>Accent</label>
            <div class="music-color-control">
              <input id="music-visual-accent" type="color" value="${esc(visual.accent || "#00f0ff")}">
              <span>${esc(visual.accent || "#00f0ff")}</span>
            </div>
          </div>
          <div>
            <label>Station label</label>
            <input id="music-visual-station" value="${esc(visual.station || "CastNexus Radio")}" placeholder="CastNexus Radio">
          </div>
          <div>
            <label>Fallback title</label>
            <input id="music-visual-title" value="${esc(visual.title || "CastNexus Radio")}" placeholder="CastNexus Radio">
          </div>
          <div>
            <label>Cover / logo URL</label>
            <input id="music-visual-cover" value="${esc(visual.cover || S.status?.profileImageUrl || "")}" placeholder="https://…">
          </div>
          <div class="music-wide-field">
            <label>Background image URL</label>
            <input id="music-visual-background" placeholder="https://…" value="${esc(visual.background || "")}">
          </div>
        </div>

        <div class="music-appearance-actions">
          <button class="btn btn-primary btn-sm" data-action="save-music-visual">Save radio appearance</button>
          <span class="muted">Changes reload the broadcaster automatically.</span>
        </div>
      </div>

      <div class="card-panel music-worker-card">
        <div class="music-card-heading compact">
          <div>
            <div class="eyebrow">24/7 ENGINE</div>
            <h3>Broadcaster status</h3>
          </div>
          <span class="badge ${onAir ? "green" : trackCount ? "cyan" : "yellow"}">${onAir ? "RUNNING" : trackCount ? "READY" : "NEEDS MUSIC"}</span>
        </div>
        <div class="music-worker-list">
          <div><span>Profile</span><strong>${esc(p?.name || "No profile")}</strong></div>
          <div><span>Autostart</span><strong>${musicProfile ? "Enabled" : "Switch to Music profile"}</strong></div>
          <div><span>Library</span><strong>${trackCount} track${trackCount === 1 ? "" : "s"}</strong></div>
          <div><span>Loop</span><strong>${S.musicSettings.loop ? "On" : "Off"}</strong></div>
          <div><span>Shuffle</span><strong>${S.musicSettings.shuffle ? "On" : "Off"}</strong></div>
        </div>
        <div class="callout ${trackCount ? "" : "warn"}">${trackCount
          ? "The music24 worker can start automatically when this Music profile is active. No OBS window needs to stay open."
          : "Upload at least one audio track before the 24/7 broadcaster can start."}</div>
      </div>
    </section>

    <div class="section-title music-library-title">
      <span>Library · ${trackCount} tracks</span>
      <span class="muted">MP3 · FLAC · OGG · WAV · M4A</span>
    </div>
    <section class="card-panel music-library-card">
      <div class="list-stack">${trackCount
        ? S.tracks.map(trackRow).join("")
        : `<div class="empty-state music-empty-state"><div class="music-empty-icon">♫</div><strong>Your radio is empty</strong><span>Upload music to start building the CastNexus 24/7 station.</span></div>`}
      </div>
    </section>`;
};
