function visibleOverlays() {
  return S.overlays.filter(o => !o?.config?.system);
}

function profileMusicUrl(profile = activeProfile()) {
  if (!S.status?.twitchLogin) return "";
  const base = `/overlay/${encodeURIComponent(S.status.twitchLogin)}/music`;
  const visual = profile?.musicVisual || {};
  const q = new URLSearchParams();
  for (const key of ["accent", "background", "station", "title", "cover"]) if (visual[key]) q.set(key, visual[key]);
  return base + (q.toString() ? `?${q}` : "");
}

function overlayUrl(path) {
  return `${location.origin}/overlay/${encodeURIComponent(S.status?.twitchLogin || "")}/${path}`;
}

function currentProfileBadge(p) {
  if (!p) return "";
  const label = p.mode === "music" ? "24/7 MUSIC" : p.mode === "console" ? "CONSOLE" : "PC";
  const cls = p.mode === "music" ? "cyan" : p.mode === "console" ? "purple" : "purple";
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderProfileSelect() {
  const select = $("#profile-select");
  if (!select) return;
  select.innerHTML = S.profiles.map(p => `<option value="${esc(p.id)}" ${p.id === S.activeProfileId ? "selected" : ""}>${esc(p.name)} · ${esc(MODE_LABELS[p.mode] || p.mode)}</option>`).join("");
  const p = activeProfile();
  const dot = $("#active-profile-dot");
  if (dot) dot.style.background = p?.color || PROFILE_COLORS[p?.mode] || "#7c5cff";
}

function liveState() {
  if (S.status?.graceUntil && Date.now() < S.status.graceUntil) return { key:"grace", title:"Reconnecting", sub:"Outputs held during grace window" };
  if (S.status?.live) {
    const p = activeProfile();
    return { key:"live", title:"Live", sub: p?.mode === "music" ? "24/7 music engine is publishing" : `${S.status.activeSource || "source"} is driving output` };
  }
  return { key:"idle", title:"Idle", sub: activeProfile()?.mode === "music" && !S.tracks.length ? "Add music to start 24/7" : "Waiting for a source" };
}

function updateChrome() {
  const ls = liveState();
  const sideDot = $("#side-status-dot");
  sideDot?.classList.remove("live", "grace");
  if (ls.key !== "idle") sideDot?.classList.add(ls.key);
  if ($("#side-status-title")) $("#side-status-title").textContent = ls.title;
  if ($("#side-status-sub")) $("#side-status-sub").textContent = ls.sub;

  const pill = $("#global-live-pill");
  if (pill) {
    pill.className = `live-pill ${ls.key === "live" ? "live" : ""}`;
    const dot = $(".status-dot", pill);
    dot?.classList.remove("live", "grace");
    if (ls.key !== "idle") dot?.classList.add(ls.key);
    const text = $("span:last-child", pill);
    if (text) text.textContent = ls.title;
  }
  if ($("#account-avatar")) {
    $("#account-avatar").src = S.status?.profileImageUrl || "";
    $("#account-avatar").title = S.status?.displayName || S.status?.twitchLogin || "Account";
  }
  renderProfileSelect();
}

function pageHead(kicker, title, description, actions = "") {
  return `<div class="page-head"><div><div class="eyebrow">${esc(kicker)}</div><h2>${esc(title)}</h2><p>${esc(description)}</p></div><div class="page-actions">${actions}</div></div>`;
}

function sourceLabel() {
  const p = activeProfile();
  if (p?.mode === "music") return "Music engine";
  if (S.status?.activeSource === "console") return "Console";
  if (S.status?.activeSource === "pc") return "PC / OBS";
  return MODE_LABELS[p?.mode] || "None";
}

function renderOverview() {
  const ls = liveState();
  const p = activeProfile();
  const dests = S.status?.destinations || [];
  const enabled = dests.filter(d => d.enabled).length;
  const active = dests.filter(d => d.active).length;
  const overlayCount = visibleOverlays().length;
  const preview = p?.mode === "music" ? profileMusicUrl(p) : (S.status?.playback?.webPlayer || `/overlay/${encodeURIComponent(S.status.twitchLogin)}/master`);
  const compositorText = p?.mode === "music" ? "Music renderer" : (S.compositor.enabled ? "Built-in compositor" : "Browser-source only");

  return `
    ${pageHead("BROADCAST OVERVIEW", `Welcome back, ${S.status?.displayName || S.status?.twitchLogin || "streamer"}`, "Your active source, destinations, overlays and profile at a glance.", `<button class="btn btn-ghost" data-action="save-profile">Save profile state</button>`)}
    <section class="card-panel hero-status">
      <div class="hero-content">
        <div class="broadcast-state">
          <div class="eyebrow">PROGRAM STATUS · ${esc(p?.name || "DEFAULT")}</div>
          <div class="big-status"><span class="status-dot ${ls.key !== "idle" ? ls.key : ""}"></span>${esc(ls.title)}</div>
          <p>${esc(ls.sub)}. Active workspace: <strong>${esc(MODE_LABELS[p?.mode] || "Unconfigured")}</strong>. ${p?.mode === "music" ? "The Docker music worker renders the spectrum scene and publishes it as a normal internal source." : "Enable the compositor to bake RestreamNode scenes and overlays directly into the outgoing stream."}</p>
          <div class="page-actions">${currentProfileBadge(p)}<span class="badge ${S.compositor.enabled ? "green" : ""}">${esc(compositorText)}</span><span class="badge">${enabled} outputs enabled</span></div>
        </div>
        <div class="hero-meters">
          <div class="meter-row"><span>Source</span><div class="meter"><span style="width:${S.status?.live ? 100 : 18}%"></span></div><b>${esc(sourceLabel())}</b></div>
          <div class="meter-row"><span>Destinations</span><div class="meter"><span style="width:${enabled ? Math.max(20, (active/enabled)*100) : 0}%"></span></div><b>${active}/${enabled}</b></div>
          <div class="meter-row"><span>Overlay stack</span><div class="meter"><span style="width:${Math.min(100, 15 + overlayCount*14)}%"></span></div><b>${overlayCount}</b></div>
          <div class="meter-row"><span>Music library</span><div class="meter"><span style="width:${Math.min(100, S.tracks.length*8)}%"></span></div><b>${S.tracks.length} tracks</b></div>
        </div>
      </div>
    </section>
    <div class="section-title">At a glance</div>
    <section class="grid grid-4">
      <div class="card-panel stat-card"><div class="stat-label">Active profile</div><div class="stat-value">${esc(p?.name || "—")}</div><div class="stat-sub">${esc(MODE_LABELS[p?.mode] || "No mode")}</div></div>
      <div class="card-panel stat-card"><div class="stat-label">Restream outputs</div><div class="stat-value">${enabled}</div><div class="stat-sub">${active} currently publishing</div></div>
      <div class="card-panel stat-card"><div class="stat-label">Custom overlays</div><div class="stat-value">${overlayCount}</div><div class="stat-sub">HTML, browser, text & music</div></div>
      <div class="card-panel stat-card"><div class="stat-label">Music library</div><div class="stat-value">${S.tracks.length}</div><div class="stat-sub">Shuffle ${S.musicSettings.shuffle ? "on" : "off"} · Loop ${S.musicSettings.loop ? "on" : "off"}</div></div>
    </section>
    <div class="section-title">Program preview</div>
    <section class="grid grid-2">
      <div class="card-panel">
        <div class="card-title-row"><h3>Live / scene preview</h3><button class="btn btn-ghost btn-sm" data-open-url="${esc(preview)}">Open</button></div>
        <p>${p?.mode === "music" ? "Spectrum + now-playing scene rendered by the same page used for the 24/7 broadcast." : S.status?.live ? "Current public playback feed." : "No source is live, so this shows your master overlay scene."}</p>
        <div class="preview-frame"><span class="preview-label">PROGRAM</span><iframe src="${esc(preview)}" allow="autoplay; fullscreen" loading="lazy"></iframe></div>
      </div>
      <div class="card-panel">
        <div class="card-title-row"><h3>Master overlay URL</h3><span class="badge purple">OBS BROWSER SOURCE</span></div>
        <p>Add this once in OBS and switch Starting Soon / BRB / Ending / custom overlays from RestreamNode without editing OBS again.</p>
        <div class="copy-field"><input readonly value="${esc(overlayUrl("master"))}"><button class="btn btn-ghost btn-sm" data-copy="${esc(overlayUrl("master"))}">Copy</button></div>
        <div class="section-title">Quick scene</div>
        ${sceneButtons()}
      </div>
    </section>`;
}

function sceneKey(scene) {
  if (!scene) return "none";
  if (scene.kind === "builtin") return `builtin:${scene.name}`;
  if (scene.kind === "custom") return `custom:${scene.overlayId}`;
  return "none";
}

function sceneButtons() {
  const current = sceneKey(S.scene);
  const defs = [
    ["none", "None", { kind:"none" }],
    ["builtin:startingSoon", "Starting Soon", { kind:"builtin", name:"startingSoon" }],
    ["builtin:brb", "BRB", { kind:"builtin", name:"brb" }],
    ["builtin:ending", "Ending", { kind:"builtin", name:"ending" }],
  ];
  const custom = visibleOverlays().filter(o => o.type === "text" || o.type === "html").map(o => [`custom:${o.id}`, o.name, { kind:"custom", overlayId:o.id }]);
  return `<div class="scene-buttons">${[...defs, ...custom].map(([key,label,scene]) => `<button class="scene-button ${current === key ? "active" : ""}" data-scene='${esc(JSON.stringify(scene))}'>${esc(label)}</button>`).join("")}</div>`;
}

function renderSources() {
  const p = activeProfile();
  const consoleEnabled = p?.mode === "console";
  const pcEnabled = p?.mode === "pc";
  const musicEnabled = p?.mode === "music";
  return `
    ${pageHead("INPUT ROUTING", "Sources", "Three purpose-built source modes. Profiles remember which workflow you want and can be switched from the top bar.")}
    <section class="grid grid-3">
      ${sourceModeCard("pc", "◫", "PC Streaming", "OBS, Streamlabs or any RTMP encoder publishes directly to RestreamNode.", pcEnabled)}
      ${sourceModeCard("console", "⌁", "Console Streaming", "Intercept console broadcasting, then add RestreamNode overlays and destinations.", consoleEnabled)}
      ${sourceModeCard("music", "♫", "24/7 Music", "Docker renders your spectrum scene and publishes music continuously without OBS.", musicEnabled)}
    </section>
    <div class="section-title">Active source configuration</div>
    ${musicEnabled ? renderMusicSourceSetup() : consoleEnabled ? renderConsoleSourceSetup() : renderPcSourceSetup()}
    <div class="section-title">Overlay compositor</div>
    <section class="card-panel">
      <div class="card-title-row"><div><h3>Bake overlays into the outgoing video</h3><p>${musicEnabled ? "24/7 Music already uses its own headless renderer, so the normal live-feed compositor is disabled for this profile." : "Headless Chromium combines your live source with the master scene and widgets before fan-out to destinations."}</p></div>
        <label class="toggle"><input id="compositor-toggle" type="checkbox" ${S.compositor.enabled ? "checked" : ""} ${musicEnabled ? "disabled" : ""}><span class="toggle-track"></span></label>
      </div>
      ${!musicEnabled ? `<div class="callout warn">The compositor adds CPU usage because it re-encodes video. Leave it off if you only want OBS Browser Sources; turn it on when you want console/PC output with overlays baked in server-side.</div>` : ""}
    </section>`;
}

function sourceModeCard(mode, icon, title, desc, active) {
  return `<div class="card-panel hoverable ${active ? "active-profile" : ""}"><div class="source-card"><div class="source-icon">${icon}</div><div class="item-main"><strong>${esc(title)}</strong><span>${active ? "ACTIVE PROFILE MODE" : "AVAILABLE AS A PROFILE"}</span></div>${active ? `<span class="badge green">ACTIVE</span>` : ""}</div><p>${esc(desc)}</p><button class="btn ${active ? "btn-ghost" : "btn-primary"} btn-sm" data-create-or-switch-mode="${mode}">${active ? "Current mode" : `Create ${title} profile`}</button></div>`;
}
