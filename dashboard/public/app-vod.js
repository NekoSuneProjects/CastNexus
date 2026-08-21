"use strict";

PAGE_TITLES.reruns = "Reruns / VOD";

const VOD_UI = { items: [], status: { state:"idle" }, timer: null };

function vodFmtDuration(sec) {
  sec = Math.max(0, Number(sec) || 0);
  if (!sec) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
}

function vodKindLabel(kind) {
  return ({ upload:"Uploaded video", youtube:"YouTube VOD", "twitch-vod":"Twitch VOD", "twitch-live":"Twitch Live HLS" })[kind] || kind;
}

function renderVodPage() {
  const p = activeProfile();
  const pcProfile = p?.mode === "pc";
  return `
    ${pageHead("PC RERUN ENGINE", "Reruns / VOD", "Relay an authorized Twitch live HLS feed, rerun Twitch/YouTube VODs, or upload video files as profile-scoped rerun assets.")}

    <section class="card-panel vod-program-card">
      <div class="card-title-row">
        <div><div class="eyebrow">PROGRAM SOURCE</div><h3>Rerun / relay status</h3></div>
        <span id="vod-state-badge" class="badge">LOADING</span>
      </div>
      <div id="vod-status-body" class="callout">Checking rerun engine…</div>
      ${pcProfile ? "" : `<div class="callout warn" style="margin-top:12px">This is a PC Streaming feature. You can manage the library here, but switch to a PC profile before starting a Twitch relay or VOD rerun.</div>`}
      <div class="page-actions" style="margin-top:12px"><button id="vod-stop" class="btn btn-danger btn-sm">Stop rerun / relay</button></div>
    </section>

    <div class="section-title">Twitch live → HLS/m3u8 relay</div>
    <section class="grid grid-2">
      <div class="card-panel">
        <div class="card-title-row"><div><h3>Relay a Twitch live channel</h3><p>CastNexus resolves Twitch's current HLS/m3u8 source and republishes it into the normal restream fan-out.</p></div><span class="badge purple">TWITCH LIVE</span></div>
        <label>Channel name or twitch.tv channel URL</label>
        <input id="vod-twitch-live" placeholder="channelname or https://www.twitch.tv/channelname">
        <label class="check-row" style="margin-top:12px"><input id="vod-twitch-auth" type="checkbox"> I own this broadcast or have permission to relay it outside Twitch.</label>
        <div class="page-actions" style="margin-top:12px"><button id="vod-twitch-start" class="btn btn-primary" ${pcProfile ? "" : "disabled"}>Start Twitch relay</button></div>
      </div>
      <div class="card-panel">
        <h3>How it routes</h3>
        <p>Twitch HLS is resolved at start time, then FFmpeg publishes it to CastNexus's private <code>relay/&lt;pc-key&gt;</code> source. Your normal enabled destinations take over from there.</p>
        <div class="callout">This does not use or expose your Twitch stream key, and it does not publish into the OBS <code>live/&lt;pc-key&gt;</code> path.</div>
        <div class="callout warn" style="margin-top:10px">If OBS is already the active CastNexus source, the relay remains standby until that source stops. This prevents two publishers from fighting over the same destinations.</div>
      </div>
    </section>

    <div class="section-title">Add remote VOD</div>
    <section class="grid grid-2">
      <div class="card-panel">
        <div class="card-title-row"><h3>Twitch / YouTube URL</h3><span class="badge cyan">REMOTE VOD</span></div>
        <div class="form-grid">
          <div><label>Source</label><select id="vod-remote-kind"><option value="twitch-vod">Twitch VOD / past broadcast</option><option value="youtube">YouTube video / past livestream</option></select></div>
          <div class="full"><label>URL</label><input id="vod-remote-url" placeholder="https://www.twitch.tv/videos/... or https://www.youtube.com/watch?v=..."></div>
          <label class="check-row full"><input id="vod-remote-auth" type="checkbox"> I own this content or have permission to rerun it.</label>
        </div>
        <div class="page-actions" style="margin-top:12px"><button id="vod-remote-add" class="btn btn-primary">Inspect & add to this profile</button></div>
      </div>
      <div class="card-panel">
        <div class="card-title-row"><h3>YouTube network note</h3><span class="badge">YT-DLP NIGHTLY + DENO</span></div>
        <p>CastNexus uses current yt-dlp nightly with Deno for YouTube extraction and does not request browser cookies.</p>
        <div class="callout warn">YouTube frequently challenges hosting/VPS/datacenter IPs. For the most reliable URL resolving, run the desktop/self-hosted instance from a normal home/residential connection. A residential IP is not a guarantee, but it generally avoids many datacenter-specific challenges.</div>
        <div class="callout" style="margin-top:10px">If YouTube responds with a sign-in, cookie or “not a bot” challenge, CastNexus stops there and tells you to upload the video manually instead of asking for browser cookies.</div>
      </div>
    </section>

    <div class="section-title">Upload rerun video</div>
    <section class="card-panel">
      <div class="card-title-row"><div><h3>Profile VOD uploads</h3><p>These files exist only in the active profile's rerun library.</p></div><label class="btn btn-primary btn-sm" style="margin:0"><input id="vod-upload-input" type="file" accept="video/*" hidden>＋ Upload video</label></div>
      <div class="callout">VOD uploads are deliberately separate from Overlay Studio backgrounds. Uploaded rerun videos are never offered as scene/background media.</div>
    </section>

    <div class="section-title">${esc(p?.name || "Profile")} VOD library</div>
    <section class="card-panel"><div id="vod-library" class="list-stack"><div class="empty-state"><strong>Loading library…</strong></div></div></section>`;
}

function vodItemRow(item) {
  const remote = item.kind !== "upload";
  return `<div class="list-row vod-item">
    <div class="track-icon">▶</div>
    <div class="item-main"><strong>${esc(item.title || "Untitled VOD")}</strong><span>${esc(vodKindLabel(item.kind))}${item.uploader ? ` · ${esc(item.uploader)}` : ""} · ${vodFmtDuration(item.durationS)}</span></div>
    <span class="badge ${item.kind === "youtube" ? "cyan" : item.kind === "twitch-vod" ? "purple" : ""}">${esc(vodKindLabel(item.kind).toUpperCase())}</span>
    <div class="item-actions">
      <button class="btn btn-primary btn-sm" data-vod-play="${esc(item.id)}">Play</button>
      <button class="btn btn-ghost btn-sm" data-vod-loop="${esc(item.id)}">Loop</button>
      ${remote && item.url ? `<button class="icon-button" data-open-url="${esc(item.url)}" title="Open source">↗</button>` : ""}
      <button class="icon-button" data-vod-delete="${esc(item.id)}" title="Delete">×</button>
    </div>
  </div>`;
}

async function loadVodUi() {
  const p = activeProfile();
  if (!p?.id || S.page !== "reruns") return;
  try {
    const [library, status] = await Promise.all([
      api(`/api/vod/items?profileId=${encodeURIComponent(p.id)}`),
      api("/api/vod/status"),
    ]);
    VOD_UI.items = library.items || [];
    VOD_UI.status = status || { state:"idle" };
    paintVodUi();
  } catch (e) {
    const body = $("#vod-status-body"); if (body) body.textContent = e.message;
  }
}

function paintVodUi() {
  if (S.page !== "reruns") return;
  const badge = $("#vod-state-badge"), body = $("#vod-status-body"), library = $("#vod-library");
  const st = VOD_UI.status || { state:"idle" };
  if (badge) {
    const live = st.state === "playing";
    badge.className = `badge ${live ? "green" : st.state === "error" ? "" : "purple"}`;
    badge.textContent = String(st.state || "idle").toUpperCase();
  }
  if (body) {
    body.innerHTML = st.state === "idle"
      ? "No Twitch relay or VOD rerun is active."
      : `<strong>${esc(st.title || "Rerun")}</strong> · ${esc(vodKindLabel(st.kind || ""))}${st.loop ? " · LOOP" : ""}${st.error ? `<br><span class="form-error">${esc(st.error)}</span>` : ""}`;
  }
  if (library) {
    library.innerHTML = VOD_UI.items.length ? VOD_UI.items.map(vodItemRow).join("") : `<div class="empty-state"><strong>No rerun videos in this profile</strong>Add a Twitch/YouTube VOD URL or upload a video file.</div>`;
    wireVodLibrary();
  }
}

function wireVodLibrary() {
  const root = $("#vod-library"); if (!root) return;
  $$('[data-open-url]',root).forEach(b => b.onclick = () => openUrl(b.dataset.openUrl));
  $$('[data-vod-play]',root).forEach(b => b.onclick = () => startVodItem(b.dataset.vodPlay, false));
  $$('[data-vod-loop]',root).forEach(b => b.onclick = () => startVodItem(b.dataset.vodLoop, true));
  $$('[data-vod-delete]',root).forEach(b => b.onclick = async () => {
    const item = VOD_UI.items.find(i => i.id === b.dataset.vodDelete); if (!item) return;
    if (!(await confirmAction("Delete VOD", `Remove ${item.title} from ${activeProfile()?.name || "this profile"}'s rerun library?`))) return;
    try {
      await api(`/api/vod/items/${encodeURIComponent(item.id)}?profileId=${encodeURIComponent(activeProfile().id)}`, { method:"DELETE" });
      toast("VOD removed", "success"); await loadVodUi();
    } catch (e) { toast(e.message, "error"); }
  });
}

async function startVodItem(itemId, loop) {
  const p = activeProfile();
  if (p?.mode !== "pc") return toast("Switch to a PC Streaming profile before starting a rerun", "error");
  try {
    await api("/api/vod/play", { method:"POST", body:{ profileId:p.id, itemId, loop } });
    toast(loop ? "VOD loop starting" : "VOD rerun starting", "success");
    await loadVodUi();
  } catch (e) { toast(e.message, "error"); }
}

function wireVodPage() {
  const p = activeProfile();
  $("#vod-stop")?.addEventListener("click", async () => {
    try { await api("/api/vod/stop", { method:"POST" }); toast("Rerun stopped", "success"); await loadVodUi(); } catch (e) { toast(e.message,"error"); }
  });
  $("#vod-twitch-start")?.addEventListener("click", async () => {
    const channel = $("#vod-twitch-live").value.trim(), authorized = $("#vod-twitch-auth").checked;
    try {
      await api("/api/vod/twitch-live", { method:"POST", body:{ profileId:p?.id, channel, authorized } });
      toast("Twitch HLS relay starting", "success"); await loadVodUi();
    } catch (e) { toast(e.message,"error"); }
  });
  $("#vod-remote-add")?.addEventListener("click", async () => {
    const kind = $("#vod-remote-kind").value, url = $("#vod-remote-url").value.trim(), authorized = $("#vod-remote-auth").checked;
    const button = $("#vod-remote-add"); button.disabled = true; button.textContent = "Inspecting…";
    try {
      await api("/api/vod/remote", { method:"POST", body:{ profileId:p?.id, kind, url, authorized } });
      $("#vod-remote-url").value = ""; toast("VOD added to this profile", "success"); await loadVodUi();
    } catch (e) { toast(e.message,"error"); }
    finally { button.disabled = false; button.textContent = "Inspect & add to this profile"; }
  });
  const upload = $("#vod-upload-input");
  if (upload) upload.onchange = async () => {
    const file = upload.files?.[0]; if (!file) return;
    const fd = new FormData(); fd.append("file", file);
    try {
      toast(`Uploading ${file.name}…`);
      await api(`/api/vod/upload?profileId=${encodeURIComponent(p?.id || "")}`, { method:"POST", body:fd });
      toast("Rerun video uploaded", "success"); await loadVodUi();
    } catch (e) { toast(e.message,"error"); }
    upload.value = "";
  };
  loadVodUi();
  clearInterval(VOD_UI.timer);
  VOD_UI.timer = setInterval(() => { if (S.page === "reruns") loadVodUi(); }, 2000);
}

function injectVodNav() {
  const nav = $("#main-nav");
  if (!nav || $("[data-page='reruns']", nav)) return;
  const btn = document.createElement("button");
  btn.className = "nav-item";
  btn.dataset.page = "reruns";
  btn.innerHTML = "<span>▶</span>Reruns / VOD";
  const profiles = $("[data-page='profiles']", nav);
  nav.insertBefore(btn, profiles || null);
}

const baseRenderPageForVod = renderPage;
renderPage = function castNexusRenderPageWithVod() {
  clearInterval(VOD_UI.timer); VOD_UI.timer = null;
  if (S.page !== "reruns") return baseRenderPageForVod();
  const root = $("#page-content"); if (!root) return;
  $("#page-title").textContent = PAGE_TITLES.reruns;
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === "reruns"));
  stopMusicNowPolling();
  root.innerHTML = renderVodPage();
  wireVodPage();
};

injectVodNav();
