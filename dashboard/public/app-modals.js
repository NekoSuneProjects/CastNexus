function renderSettings() {
  const p = activeProfile();
  return `
    ${pageHead("SYSTEM", "Settings", "Connection details and safe defaults for this CastNexus instance.")}
    <section class="grid grid-2">
      <div class="card-panel"><div class="card-title-row"><h3>Account</h3><img class="avatar" src="${esc(S.status?.profileImageUrl || "")}" alt=""></div><p>Signed in as <strong>${esc(S.status?.displayName || S.status?.twitchLogin)}</strong> · @${esc(S.status?.twitchLogin || "")}</p><button class="btn btn-ghost btn-sm" data-action="logout">Sign out</button></div>
      <div class="card-panel"><h3>Active workspace</h3><p>${esc(p?.name || "—")} · ${esc(MODE_LABELS[p?.mode] || "—")} · ${p?.canvasMode === "vertical" ? "9:16 Vertical" : "16:9 Landscape"}</p><button class="btn btn-ghost btn-sm" data-nav="profiles">Manage profiles</button></div>
      <div class="card-panel"><h3>Public playback</h3><p>When a source is live CastNexus exposes WebRTC/WHEP, HLS, RTSP and SRT playback URLs.</p>${S.status?.playback ? Object.entries(S.status.playback).map(([k,v]) => `<label>${esc(k)}</label><div class="copy-field"><input readonly value="${esc(v)}"><button class="btn btn-ghost btn-sm" data-copy="${esc(v)}">Copy</button></div>`).join("") : `<div class="callout">Playback URLs appear once a source is live.</div>`}</div>
      <div class="card-panel"><h3>Security notes</h3><p>Use Browser / iframe overlays for third-party widget URLs. They are sandboxed. Raw HTML/CSS overlays are intentionally trusted code and should only contain code you control.</p><div class="callout warn">The real Twitch stream key is only required for Console profiles and is masked after saving. PC and Music profiles use the separate CastNexus-generated PC ingest key.</div></div>
    </section>`;
}

function renderPage() {
  const root = $("#page-content");
  if (!root) return;
  $("#page-title").textContent = PAGE_TITLES[S.page] || "CastNexus";
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === S.page));
  stopMusicNowPolling();
  const renderer = {
    overview: renderOverview,
    sources: renderSources,
    destinations: renderDestinations,
    studio: renderStudio,
    music: renderMusic,
    profiles: renderProfiles,
    settings: renderSettings,
  }[S.page] || renderOverview;
  root.innerHTML = renderer();
  wirePage();
  if (S.page === "music") startMusicNowPolling();
}

function navigate(page) {
  if (!PAGE_TITLES[page]) return;
  S.page = page;
  renderPage();
  $(".sidebar")?.classList.remove("open");
  window.scrollTo({ top:0, behavior:"smooth" });
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast("Copied", "success")).catch(() => toast("Could not copy", "error"));
}

function openUrl(url) { if (url) window.open(url, "_blank", "noopener,noreferrer"); }

function closeModal() { $("#modal-root").innerHTML = ""; }

function modalShell(title, kicker, body, foot = "", large = false) {
  $("#modal-root").innerHTML = `<div class="modal-backdrop"><div class="modal ${large ? "modal-lg" : ""}"><div class="modal-head"><div><div class="eyebrow">${esc(kicker)}</div><h3>${esc(title)}</h3></div><button class="icon-button" data-modal-close>×</button></div>${body}${foot ? `<div class="modal-foot">${foot}</div>` : ""}</div></div>`;
  $("[data-modal-close]")?.addEventListener("click", closeModal);
  $(".modal-backdrop")?.addEventListener("click", e => { if (e.target.classList.contains("modal-backdrop")) closeModal(); });
}

function confirmAction(title, message, confirmLabel = "Delete") {
  return new Promise(resolve => {
    modalShell(title, "CONFIRM ACTION", `<p class="muted">${esc(message)}</p>`, `<button class="btn btn-ghost" id="confirm-cancel">Cancel</button><button class="btn btn-danger" id="confirm-ok">${esc(confirmLabel)}</button>`);
    $("#confirm-cancel").onclick = () => { closeModal(); resolve(false); };
    $("#confirm-ok").onclick = () => { closeModal(); resolve(true); };
  });
}

function openDestinationModal(dest = null) {
  const currentLayout = dest?.layout || "source";
  modalShell(dest ? "Edit destination" : "Add destination", "OUTPUT ROUTE", `
    <div class="form-grid">
      <div class="full"><label>Name</label><input id="dest-name" value="${esc(dest?.name || "")}" placeholder="YouTube Horizontal"></div>
      <div class="full"><label>${dest ? "New URL (leave blank to keep current)" : "RTMP / RTMPS / SRT URL"}</label><input id="dest-url" placeholder="rtmps://…" value=""></div>
      <div class="full"><label>Output layout</label><select id="dest-layout">
        <option value="source" ${currentLayout === "source" ? "selected" : ""}>Source / passthrough (no video re-encode)</option>
        <option value="landscape" ${currentLayout === "landscape" ? "selected" : ""}>16:9 Landscape · 1920×1080</option>
        <option value="vertical" ${currentLayout === "vertical" ? "selected" : ""}>9:16 Vertical · 1080×1920</option>
      </select></div>
    </div>
    <div class="callout" style="margin-top:12px">For YouTube Dual Stream, add two destinations: the normal stream key as 16:9 and YouTube's second vertical stream key as 9:16. Vertical/forced layouts require FFmpeg transcoding.</div>
    <div id="modal-error" class="form-error"></div>`, `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="dest-save">Save destination</button>`, true);
  $$('[data-modal-close]').forEach(b => b.onclick = closeModal);
  $("#dest-save").onclick = async () => {
    const name = $("#dest-name").value.trim(), url = $("#dest-url").value.trim(), layout = $("#dest-layout").value;
    try {
      if (dest) {
        const body = { name, layout }; if (url) body.url = url;
        await api(`/api/destinations/${encodeURIComponent(dest.id)}`, { method:"PUT", body });
      } else {
        await api("/api/destinations", { method:"POST", body:{ name, url, layout } });
      }
      closeModal(); await refreshAndRender(); toast("Destination saved", "success");
    } catch (e) { $("#modal-error").textContent = e.message; }
  };
}

function openBuiltinModal(key) {
  const cfg = S.overlayConfig[key] || {};
  const common = `<div><label>Title</label><input id="bi-title" value="${esc(cfg.title || "")}"></div><div><label>Accent</label><input id="bi-accent" type="color" value="${esc(cfg.accent || "#7c5cff")}"></div><div class="full"><label>Subtitle</label><input id="bi-subtitle" value="${esc(cfg.subtitle || "")}"></div><div class="full"><label>Background image URL</label><input id="bi-bg" value="${esc(cfg.backgroundUrl || "")}" placeholder="https://…"></div>`;
  let extra = "";
  if (key === "startingSoon") extra = `
    <div><label>Countdown from now (minutes)</label><input id="bi-countdown-minutes" type="number" min="0" max="1440" step="1" value="${Number(cfg.countdownMinutes || 0)}" placeholder="10"></div>
    <div><label>Countdown label</label><input id="bi-countdown-label" value="${esc(cfg.countdownLabel || "Live in")}"></div>
    <div class="full"><label>Or fixed countdown target</label><input id="bi-countdown" type="datetime-local" value="${cfg.countdownAt ? esc(new Date(cfg.countdownAt).toISOString().slice(0,16)) : ""}"></div>
    <div class="callout full">Set minutes to <strong>10</strong> and every time you switch to Starting Soon, CastNexus starts a fresh 10-minute countdown. Set it to 0 to use the fixed target instead.</div>`;
  if (key === "ending") extra = `<div><label>Twitch</label><input id="bi-twitch" value="${esc(cfg.twitch || "")}"></div><div><label>YouTube</label><input id="bi-youtube" value="${esc(cfg.youtube || "")}"></div><div><label>X / Twitter</label><input id="bi-twitter" value="${esc(cfg.twitter || "")}"></div><div><label>Discord</label><input id="bi-discord" value="${esc(cfg.discord || "")}"></div>`;
  modalShell(`Edit ${key === "startingSoon" ? "Starting Soon" : key === "brb" ? "BRB" : "Ending"}`, "BUILT-IN SCENE", `<div class="form-grid">${common}${extra}</div><div id="modal-error" class="form-error"></div>`, `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="bi-save">Save scene</button>`, true);
  $$('[data-modal-close]').forEach(b => b.onclick = closeModal);
  $("#bi-save").onclick = async () => {
    const next = { title:$("#bi-title").value.trim(), subtitle:$("#bi-subtitle").value.trim(), accent:$("#bi-accent").value, backgroundUrl:$("#bi-bg").value.trim() };
    if (key === "startingSoon") {
      const v=$("#bi-countdown").value;
      next.countdownMinutes=Math.max(0,Math.min(1440,Number($("#bi-countdown-minutes").value)||0));
      next.countdownAt=v ? new Date(v).toISOString() : "";
      next.countdownLabel=$("#bi-countdown-label").value.trim();
    }
    if (key === "ending") for (const k of ["twitch","youtube","twitter","discord"]) next[k] = $("#bi-"+k).value.trim();
    try { await api("/api/overlays/config", { method:"POST", body:{ [key]:next } }); closeModal(); await refreshAndRender(); toast("Scene saved", "success"); } catch(e){ $("#modal-error").textContent=e.message; }
  };
}

function overlayFormFields(kind, o = null) {
  const c = o?.config || {};
  if (kind === "text") return `<div class="full"><label>Text</label><textarea id="ov-text">${esc(c.text || "")}</textarea></div><div><label>Font size</label><input id="ov-font-size" type="number" min="8" max="240" value="${Number(c.fontSize || 48)}"></div><div><label>Colour</label><input id="ov-color" type="color" value="${esc(c.color || "#ffffff")}"></div>`;
  if (kind === "iframe") return `<div class="full"><label>Browser source URL</label><input id="ov-url" value="${esc(c.url || "")}" placeholder="https://streamelements.com/overlay/…"></div><div><label>Width (optional)</label><input id="ov-width" type="number" min="1" value="${c.width || ""}" placeholder="800"></div><div><label>Height (optional)</label><input id="ov-height" type="number" min="1" value="${c.height || ""}" placeholder="600"></div><div><label>X position %</label><input id="ov-x" type="number" min="0" max="100" value="${c.x ?? 50}"></div><div><label>Y position %</label><input id="ov-y" type="number" min="0" max="100" value="${c.y ?? 50}"></div><label class="check-row full"><input id="ov-fullscreen" type="checkbox" ${c.fullscreen !== false ? "checked" : ""}> Full-screen iframe</label><label class="check-row full"><input id="ov-transparent" type="checkbox" ${c.transparent !== false ? "checked" : ""}> Transparent background</label>`;
  if (kind === "html") return `<div class="full"><label>HTML</label><textarea id="ov-html" placeholder="<div>…</div>">${esc(c.html || "")}</textarea></div><div class="full"><label>CSS</label><textarea id="ov-css" placeholder="body { … }">${esc(c.css || "")}</textarea></div>`;
  if (kind === "music") return `<div><label>Accent</label><input id="ov-music-accent" type="color" value="${esc(c.accent || "#00f0ff")}"></div><div><label>Station label</label><input id="ov-music-station" value="${esc(c.station || "CastNexus Radio")}"></div><div class="full"><label>Background image URL</label><input id="ov-music-bg" value="${esc(c.backgroundUrl || "")}" placeholder="https://…"></div>`;
  return "";
}

function openOverlayModal(o = null) {
  let kind = o ? (o.type === "html" && (o.config?.kind === "iframe" || o.config?.kind === "browser") ? "iframe" : o.type) : "iframe";
  const typeOptions = [["iframe","Browser / iframe"],["html","HTML / CSS"],["text","Text"],["music","Music scene"]];
  const render = () => {
    modalShell(o ? `Edit ${o.name}` : "New overlay", "OVERLAY LIBRARY", `<div class="form-grid"><div class="full"><label>Name</label><input id="ov-name" value="${esc(o?.name || "")}" placeholder="StreamElements Alerts"></div><div class="full"><label>Type</label><select id="ov-kind" ${o ? "disabled" : ""}>${typeOptions.map(([v,l]) => `<option value="${v}" ${kind===v?"selected":""}>${l}</option>`).join("")}</select></div><div id="ov-fields" class="full form-grid">${overlayFormFields(kind,o)}</div></div>${kind === "iframe" ? `<div class="callout" style="margin-top:12px">Sandbox: scripts + same-origin + presentation are allowed for alert widgets. Popups, forms and top navigation are not.</div>` : kind === "html" ? `<div class="callout warn" style="margin-top:12px">Raw HTML/CSS is trusted broadcast code. Do not paste third-party scripts here; use Browser / iframe instead.</div>` : kind === "music" ? `<div class="callout" style="margin-top:12px">This Music scene uses the active profile's isolated library, never another profile's tracks.</div>` : ""}<div id="modal-error" class="form-error"></div>`, `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="ov-save">Save overlay</button>`, true);
    $$('[data-modal-close]').forEach(b => b.onclick=closeModal);
    if (!o) $("#ov-kind").onchange = e => { kind=e.target.value; render(); };
    $("#ov-save").onclick = async () => {
      const name=$("#ov-name").value.trim(); let type=kind, config={};
      if(kind==="iframe"){ type="html"; config={ kind:"iframe", url:$("#ov-url").value.trim(), width:Number($("#ov-width").value)||null, height:Number($("#ov-height").value)||null, x:Number($("#ov-x").value)||50, y:Number($("#ov-y").value)||50, fullscreen:$("#ov-fullscreen").checked, transparent:$("#ov-transparent").checked }; }
      if(kind==="html") config={ html:$("#ov-html").value, css:$("#ov-css").value };
      if(kind==="text") config={ text:$("#ov-text").value, fontSize:Number($("#ov-font-size").value)||48, color:$("#ov-color").value };
      if(kind==="music") config={ accent:$("#ov-music-accent").value, station:$("#ov-music-station").value.trim(), backgroundUrl:$("#ov-music-bg").value.trim() };
      try {
        if(o) await api(`/api/overlays/${encodeURIComponent(o.id)}`,{method:"PUT",body:{name,config}});
        else await api("/api/overlays",{method:"POST",body:{name,type,config}});
        closeModal(); await refreshAndRender(); toast("Overlay saved","success");
      } catch(e){ $("#modal-error").textContent=e.message; }
    };
  };
  render();
}

function openProfileModal(mode, profile = null) {
  const editing = !!profile;
  const chosenMode = profile?.mode || mode || "pc";
  const canvas = profile?.canvasMode || "landscape";
  modalShell(editing ? "Edit profile" : `New ${MODE_LABELS[chosenMode]} profile`, "PROFILE", `
    <div class="form-grid">
      <div class="full"><label>Name</label><input id="pf-name" value="${esc(profile?.name || (chosenMode === "pc" ? "PC Gaming" : chosenMode === "console" ? "Console Gaming" : "24/7 Music"))}"></div>
      <div><label>Mode</label><select id="pf-mode" ${editing ? "disabled" : ""}><option value="pc" ${chosenMode==="pc"?"selected":""}>PC Streaming</option><option value="console" ${chosenMode==="console"?"selected":""}>Console Streaming</option><option value="music" ${chosenMode==="music"?"selected":""}>24/7 Music</option></select></div>
      <div><label>Profile colour</label><input id="pf-color" type="color" value="${esc(profile?.color || PROFILE_COLORS[chosenMode])}"></div>
      <div class="full"><label>Default canvas</label><select id="pf-canvas"><option value="landscape" ${canvas === "landscape" ? "selected" : ""}>16:9 Landscape · desktop / TV</option><option value="vertical" ${canvas === "vertical" ? "selected" : ""}>9:16 Vertical · TikTok / Instagram / Shorts</option></select></div>
    </div>
    <div class="callout" style="margin-top:12px">The profile canvas controls scene previews and 24/7 rendering. Individual destinations can still override to Source, 16:9 or 9:16, so one profile can feed YouTube's horizontal and vertical keys at the same time.</div>
    <div id="modal-error" class="form-error"></div>`, `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="pf-save">Save profile</button>`, true);
  $$('[data-modal-close]').forEach(b=>b.onclick=closeModal);
  $("#pf-save").onclick = async () => {
    const name=$("#pf-name").value.trim(), m=editing ? profile.mode : $("#pf-mode").value, color=$("#pf-color").value, canvasMode=$("#pf-canvas").value;
    if(!name) return $("#modal-error").textContent="Name is required";
    if(editing){ profile.name=name; profile.color=color; profile.canvasMode=canvasMode; }
    else { const p=createProfile(m,name); p.color=color; p.canvasMode=canvasMode; S.profiles.push(p); }
    try { await saveProfileStore(); closeModal(); renderProfileSelect(); renderPage(); toast("Profile saved","success"); } catch(e){ $("#modal-error").textContent=e.message; }
  };
}

function openStreamKeyModal() {
  modalShell("Replace Twitch stream key", "CONSOLE SOURCE", `<p class="muted">Paste the current Twitch stream key. It will be stored server-side and masked in the UI after saving.</p><label>Stream key</label><input id="modal-stream-key" type="password" autocomplete="off"><div id="modal-error" class="form-error"></div>`, `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="modal-stream-save">Save key</button>`);
  $$('[data-modal-close]').forEach(b=>b.onclick=closeModal);
  $("#modal-stream-save").onclick=async()=>{ try{ await api("/api/streamkey",{method:"POST",body:{streamKey:$("#modal-stream-key").value.trim()}}); closeModal(); await refreshAndRender(); toast("Stream key updated","success"); }catch(e){ $("#modal-error").textContent=e.message; } };
}

function openTrackModal(track) {
  const p = activeProfile();
  modalShell("Edit track metadata", "PROFILE MUSIC LIBRARY", `<p class="muted">Editing music for <strong>${esc(p?.name || "active profile")}</strong>. Other profiles are unaffected.</p><div class="form-grid"><div class="full"><label>Title</label><input id="track-title" value="${esc(track.title || "")}"></div><div class="full"><label>Artist</label><input id="track-artist" value="${esc(track.artist || "")}"></div></div><div id="modal-error" class="form-error"></div>`, `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-primary" id="track-save">Save metadata</button>`);
  $$('[data-modal-close]').forEach(b=>b.onclick=closeModal);
  $("#track-save").onclick=async()=>{ try{ await api(musicApiUrl(`/tracks/${encodeURIComponent(track.id)}`, p?.id),{method:"PUT",body:{title:$("#track-title").value.trim(),artist:$("#track-artist").value.trim()}}); closeModal(); await refreshAndRender(); toast("Track updated","success"); }catch(e){ $("#modal-error").textContent=e.message; } };
}

async function setScene(scene) {
  try {
    await api("/api/scenes/current", { method:"POST", body:scene });
    S.scene = scene.kind === "none" ? null : scene;
    const p=activeProfile(); if(p){p.scene=S.scene; await saveProfileStore();}
    renderPage(); toast("Scene switched","success");
  } catch(e){ toast(e.message,"error"); }
}

async function refreshAndRender() {
  await fetchCore();
  await ensureProfileStore(activeProfile()?.mode).catch(()=>{});
  updateChrome();
  renderProfileSelect();
  renderPage();
}
