// Public playback endpoints, rendered from the labelled link list the server
// now returns. The VRChat-friendly HLS URL is deliberately first and visually
// separated: it is the one URL most people actually need.

const PLAYBACK_FALLBACK_LABELS = {
  hls:{ label:"VRChat / media player URL", protocol:"HLS" },
  webPlayer:{ label:"Browser player", protocol:"WebRTC" },
  whep:{ label:"WHEP endpoint", protocol:"WebRTC" },
  rtsp:{ label:"RTSP stream", protocol:"RTSP" },
  srt:{ label:"SRT stream", protocol:"SRT" },
};

function playbackLinks() {
  const playback = S.status?.playback;
  if (!playback) return [];
  if (Array.isArray(playback.links) && playback.links.length) return playback.links;
  // Older server builds only returned the flat url map.
  return Object.keys(PLAYBACK_FALLBACK_LABELS)
    .filter(key => playback[key])
    .map(key => ({ key, url:playback[key], ...PLAYBACK_FALLBACK_LABELS[key], primary:key === "hls", openable:key === "webPlayer" }));
}

function playbackLinkRow(link) {
  const actions = [
    `<button class="btn btn-ghost btn-sm" data-copy="${esc(link.url)}">Copy</button>`,
    link.openable || /^https?:/i.test(link.url) ? `<button class="btn btn-ghost btn-sm" data-open-url="${esc(link.url)}">Open</button>` : "",
  ].join("");
  return `
    <label>${esc(link.label || link.key)}${link.protocol ? ` <span class="badge">${esc(link.protocol)}</span>` : ""}</label>
    <div class="copy-field"><input readonly value="${esc(link.url)}">${actions}</div>
    ${link.hint ? `<div class="stat-sub">${esc(link.hint)}</div>` : ""}`;
}

function playbackPrimaryCard(link) {
  if (!link) return "";
  return `
    <div class="callout" style="margin-bottom:14px">
      <div class="card-title-row"><strong>${esc(link.label)}</strong><span class="badge cyan">VRCHAT READY · ${esc(link.protocol || "HLS")}</span></div>
      <div class="copy-field" style="margin-top:8px"><input readonly value="${esc(link.url)}"><button class="btn btn-primary btn-sm" data-copy="${esc(link.url)}">Copy</button><button class="btn btn-ghost btn-sm" data-open-url="${esc(link.url)}">Open</button></div>
      ${link.hint ? `<div class="stat-sub" style="margin-top:6px">${esc(link.hint)}</div>` : ""}
    </div>`;
}

function renderPublicPlaybackPanel({ title = "Public playback", showBase = true } = {}) {
  const links = playbackLinks();
  if (!links.length) {
    return `<div class="card-panel"><div class="card-title-row"><h3>${esc(title)}</h3><span class="badge">OFFLINE</span></div><p>Playback URLs appear here as soon as a source is live.</p><div class="callout">Nothing is publishing yet, so there is no public feed to hand out.</div></div>`;
  }
  const primary = links.find(l => l.primary) || links[0];
  const rest = links.filter(l => l !== primary);
  const base = S.status?.publicBaseUrl?.effective || S.status?.playback?.base || "";
  return `
    <div class="card-panel">
      <div class="card-title-row"><h3>${esc(title)}</h3><span class="badge green">LIVE</span></div>
      <p>Share these to let people watch this feed. The first one is what VRChat video players and most media players expect.</p>
      ${playbackPrimaryCard(primary)}
      <div class="section-title">Other clients</div>
      ${rest.map(playbackLinkRow).join("")}
      ${showBase && base ? `<div class="stat-sub" style="margin-top:10px">Built from <strong>${esc(base)}</strong>${S.status?.publicBaseUrl?.lockedByEnv ? " (set by PUBLIC_BASE_URL)" : ""}. Change this under Settings → Public address if these links are wrong behind your proxy.</div>` : ""}
    </div>`;
}

function renderPublicAddressPanel() {
  const info = S.status?.publicBaseUrl || {};
  const locked = !!info.lockedByEnv;
  return `
    <div class="card-panel">
      <h3>Public address</h3>
      <p>CastNexus normally works this out from the request: it keeps <code>https://</code> when you arrive through a domain/reverse proxy and uses <code>http://</code> for a direct IP. Set this only if playback links come out wrong &mdash; for example a Docker install behind a second proxy CastNexus cannot see.</p>
      <label>Public base URL</label>
      <div class="copy-field">
        <input id="public-base-url" value="${esc(info.value || "")}" placeholder="https://castnexus.example.com"${locked ? " disabled" : ""}>
        <button class="btn btn-primary btn-sm" id="public-base-url-save"${locked ? " disabled" : ""}>Save</button>
      </div>
      <div class="stat-sub">Currently building links from <strong>${esc(info.effective || "this request")}</strong>.</div>
      ${locked ? `<div class="callout warn">PUBLIC_BASE_URL is set in the environment, so it wins over this field. Change it in your compose/env file.</div>` : `<div class="stat-sub">Leave empty to auto-detect. Trusted <code>X-Forwarded-Host</code> / <code>X-Forwarded-Proto</code> headers are honoured.</div>`}
    </div>`;
}

function wirePublicAddressPanel(root) {
  const input = $("#public-base-url", root), save = $("#public-base-url-save", root);
  if (!input || !save) return;
  save.onclick = async () => {
    save.disabled = true;
    try {
      const result = await api("/api/public-base-url", { method:"POST", body:{ value:input.value } });
      toast(result.value ? `Public address set to ${result.value}` : "Public address auto-detection restored", "success");
      await refreshAndRender();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      save.disabled = false;
    }
  };
}
