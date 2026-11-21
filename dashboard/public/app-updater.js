"use strict";

(function () {
  const build = window.CASTNEXUS_BUILD || { name:"CastNexus", version:"0.0.0-dev", channel:"dev", installType:"source", repository:"NekoSuneProjects/CastNexus" };
  const CHANNEL_KEY = "castnexus.updateChannel";
  const CHANNELS = ["stable", "beta"];
  let lastRelease = null;
  let lastCheck = null; // { at, release, upToDate, error }
  let notifiedTag = null;

  // Which releases to be told about. Defaults to the channel this build came
  // from; the user can switch in Settings -> Updates (saved per device).
  function updateChannel() {
    try { const saved = localStorage.getItem(CHANNEL_KEY); if (CHANNELS.includes(saved)) return saved; } catch {}
    return build.channel === "beta" ? "beta" : "stable";
  }
  function setUpdateChannel(value) {
    if (!CHANNELS.includes(value)) return;
    try { localStorage.setItem(CHANNEL_KEY, value); } catch {}
    notifiedTag = null;
  }

  function parseVersion(value) {
    const raw = String(value || "").trim().replace(/^v/i, "");
    const m = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { major:+m[1], minor:+m[2], patch:+m[3], pre:m[4] || "" };
  }

  function compareIdentifiers(a, b) {
    const aa = String(a || "").split("."), bb = String(b || "").split(".");
    for (let i=0; i<Math.max(aa.length, bb.length); i++) {
      if (aa[i] === undefined) return -1;
      if (bb[i] === undefined) return 1;
      if (aa[i] === bb[i]) continue;
      const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
      if (an && bn) return Number(aa[i]) > Number(bb[i]) ? 1 : -1;
      if (an !== bn) return an ? -1 : 1;
      return aa[i] > bb[i] ? 1 : -1;
    }
    return 0;
  }

  function compareVersion(a, b) {
    const av=parseVersion(a), bv=parseVersion(b);
    if (!av || !bv) return 0;
    for (const k of ["major","minor","patch"]) if (av[k] !== bv[k]) return av[k] > bv[k] ? 1 : -1;
    if (!av.pre && !bv.pre) return 0;
    if (!av.pre) return 1;
    if (!bv.pre) return -1;
    return compareIdentifiers(av.pre, bv.pre);
  }

  // Beta follows the newest release of either kind; stable ignores prereleases.
  function channelRelease(releases, channel = updateChannel()) {
    const clean = (releases || []).filter(r => !r.draft && parseVersion(r.tag_name));
    clean.sort((a, b) => compareVersion(b.tag_name, a.tag_name));
    if (channel === "beta") return clean[0] || null;
    return clean.find(r => !r.prerelease) || null;
  }

  // Desktop: the installer / AppImage for this OS from the release assets.
  function desktopAsset(release) {
    const assets = release?.assets || [];
    const ua = navigator.userAgent || "";
    if (/Windows/i.test(ua)) return assets.find(a => /setup.*\.exe$/i.test(a.name)) || assets.find(a => /\.exe$/i.test(a.name) && !/cli/i.test(a.name)) || null;
    if (/Linux/i.test(ua)) return assets.find(a => /\.AppImage$/i.test(a.name)) || assets.find(a => /\.deb$/i.test(a.name)) || null;
    return null;
  }

  function updateCommand(channel = updateChannel()) {
    if (build.installType === "docker") {
      const beta = channel === "beta";
      return `${beta ? "CASTNEXUS_IMAGE_TAG=beta CASTNEXUS_CHANNEL=beta " : "CASTNEXUS_IMAGE_TAG=latest CASTNEXUS_CHANNEL=stable "}docker compose pull && docker compose up -d`;
    }
    if (build.installType === "electron") return "Download the installer, close CastNexus Studio, run the installer, then start CastNexus again. Your settings, profiles and VODs are kept.";
    return "Download the new CastNexus bundle from the release page, close CastNexus, replace the old files, then start it again.";
  }

  function openRelease(release) {
    const asset = build.installType === "electron" ? desktopAsset(release) : null;
    window.open(asset?.browser_download_url || release.html_url, "_blank", "noopener,noreferrer");
  }

  function showUpdate(release) {
    lastRelease = release;
    const tag = release.tag_name || release.name || "new release";
    if (notifiedTag === tag) return;
    notifiedTag = tag;
    document.getElementById("castnexus-update-banner")?.remove();
    const asset = build.installType === "electron" ? desktopAsset(release) : null;

    const banner = document.createElement("div");
    banner.id = "castnexus-update-banner";
    banner.style.cssText = "position:fixed;right:18px;top:96px;z-index:90;width:min(390px,calc(100vw - 36px));padding:14px;border:1px solid rgba(56,232,255,.22);border-radius:14px;background:rgba(11,15,27,.96);box-shadow:0 20px 55px rgba(0,0,0,.45);backdrop-filter:blur(18px);font-family:Inter,ui-sans-serif,system-ui;color:#f4f6ff";
    banner.innerHTML = `
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="width:38px;height:38px;display:grid;place-items:center;border-radius:11px;background:rgba(56,232,255,.10);color:#38e8ff;border:1px solid rgba(56,232,255,.16);font-weight:900">↑</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:.66rem;letter-spacing:.16em;color:#78839b;font-weight:800">CASTNEXUS UPDATE · ${escapeHtml(updateChannel().toUpperCase())}</div>
          <strong style="display:block;margin-top:3px;font-size:.92rem">${escapeHtml(tag)} is available</strong>
          <div style="font-size:.72rem;color:#8f98af;margin-top:4px">Installed: ${escapeHtml(build.version)} · ${escapeHtml(build.channel)}</div>
          <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap">
            <button id="cn-update-open" style="border:0;border-radius:9px;padding:8px 10px;background:#7c5cff;color:white;font-weight:800;cursor:pointer">${asset ? "Download update" : "View release"}</button>
            <button id="cn-update-how" style="border:1px solid rgba(255,255,255,.09);border-radius:9px;padding:8px 10px;background:rgba(255,255,255,.03);color:#aab3c7;font-weight:750;cursor:pointer">How to update</button>
            <button id="cn-update-dismiss" style="border:0;background:transparent;color:#687187;cursor:pointer">Dismiss</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(banner);
    banner.querySelector("#cn-update-open").onclick = () => openRelease(release);
    banner.querySelector("#cn-update-dismiss").onclick = () => banner.remove();
    banner.querySelector("#cn-update-how").onclick = () => {
      if (typeof modalShell === "function") {
        modalShell("Update CastNexus", `${String(build.installType || "install").toUpperCase()} · ${updateChannel().toUpperCase()}`, `<p class="muted">A newer CastNexus build is available: <strong>${escapeHtml(tag)}</strong>.</p><div class="code-note">${escapeHtml(updateCommand())}</div><p class="muted">Beta follows prereleases (newest features, may be less stable). Stable only notifies for normal releases. Change this in Settings → Updates.</p>`, `<button class="btn btn-ghost" data-modal-close>Close</button><button class="btn btn-primary" id="cn-release-open-modal">${asset ? "Download update" : "Open release"}</button>`);
        document.querySelectorAll('[data-modal-close]').forEach(b => b.onclick = closeModal);
        const open = document.querySelector("#cn-release-open-modal");
        if (open) open.onclick = () => openRelease(release);
      } else {
        alert(updateCommand());
      }
    };
    if (typeof toast === "function") toast(`CastNexus ${tag} is available`, "success");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  async function check({ manual = false } = {}) {
    if (!parseVersion(build.version) || build.channel === "dev") {
      if (manual && typeof toast === "function") toast("This is a development build - update checks are off", "error");
      return null;
    }
    try {
      const res = await fetch(`https://api.github.com/repos/${build.repository}/releases?per_page=30`, { headers:{ "Accept":"application/vnd.github+json" }, cache:"no-store" });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const release = channelRelease(await res.json());
      const newer = !!release?.tag_name && compareVersion(release.tag_name, build.version) > 0;
      lastCheck = { at:new Date(), release, upToDate:!newer, error:null };
      if (newer) { if (manual) notifiedTag = null; showUpdate(release); }
      else if (manual && typeof toast === "function") toast(`You're up to date (${build.version}, ${updateChannel()} channel)`, "success");
    } catch (error) {
      lastCheck = { at:new Date(), release:null, upToDate:null, error:error.message };
      if (manual && typeof toast === "function") toast(`Update check failed: ${error.message}`, "error");
    }
    paintSettingsCard();
    return lastCheck;
  }

  // ------------------------------------------------- Settings -> Updates
  function settingsCard() {
    const ch = updateChannel();
    return `<section class="card-panel" id="cn-updates-panel" style="margin-top:16px"><div class="card-title-row"><div><h3>Updates</h3><p>Installed <strong>${escapeHtml(build.version)}</strong> (${escapeHtml(build.channel)} build, ${escapeHtml(build.installType)}).</p></div><span class="badge ${ch === "beta" ? "purple" : "green"}">${ch.toUpperCase()}</span></div>
      <div class="form-grid"><div><label>Update channel</label><select id="cn-update-channel"><option value="stable" ${ch === "stable" ? "selected" : ""}>Stable - normal releases only</option><option value="beta" ${ch === "beta" ? "selected" : ""}>Beta - newest prereleases too</option></select></div>
      <div style="display:flex;align-items:flex-end"><button id="cn-update-check" class="btn btn-primary">Check for updates</button></div></div>
      <div id="cn-update-result" class="stat-sub" style="margin-top:10px"></div>
      ${build.installType === "docker" ? `<div class="callout" style="margin-top:10px">Docker follows the image tag in <code>.env</code> (<code>CASTNEXUS_IMAGE_TAG=latest</code> or <code>beta</code>). This setting only changes which releases you are told about.</div>` : ""}</section>`;
  }

  function paintSettingsCard() {
    const out = document.getElementById("cn-update-result");
    if (!out) return;
    if (!lastCheck) { out.textContent = "Checks GitHub releases automatically every 6 hours."; return; }
    const when = lastCheck.at.toLocaleTimeString();
    if (lastCheck.error) out.textContent = `Last check ${when}: failed (${lastCheck.error}).`;
    else if (lastCheck.upToDate) out.textContent = `Last check ${when}: up to date${lastCheck.release?.tag_name ? ` (latest ${updateChannel()}: ${lastCheck.release.tag_name})` : ""}.`;
    else out.innerHTML = `Last check ${escapeHtml(when)}: <strong>${escapeHtml(lastCheck.release.tag_name)}</strong> is available. <a href="#" id="cn-update-get">${build.installType === "electron" && desktopAsset(lastCheck.release) ? "Download" : "Open release"}</a>`;
    const get = document.getElementById("cn-update-get");
    if (get) get.onclick = e => { e.preventDefault(); openRelease(lastCheck.release); };
  }

  if (typeof window.renderSettings === "function") {
    const baseRenderSettings = window.renderSettings;
    // First card on Settings (right under the page header) so the stable /
    // beta choice is easy to find.
    window.renderSettings = function renderSettingsWithUpdates() {
      const html = baseRenderSettings();
      const card = settingsCard().replace('style="margin-top:16px"', 'style="margin-bottom:16px"');
      const headEnd = html.indexOf('<section');
      return headEnd >= 0 ? html.slice(0, headEnd) + card + html.slice(headEnd) : card + html;
    };
  }
  document.addEventListener("change", e => {
    if (e.target?.id !== "cn-update-channel") return;
    setUpdateChannel(e.target.value);
    const badge = document.querySelector("#cn-updates-panel .badge");
    if (badge) { badge.textContent = e.target.value.toUpperCase(); badge.className = `badge ${e.target.value === "beta" ? "purple" : "green"}`; }
    check({ manual:true });
  });
  document.addEventListener("click", e => {
    if (e.target?.id !== "cn-update-check") return;
    e.target.disabled = true;
    check({ manual:true }).finally(() => { e.target.disabled = false; });
  });
  new MutationObserver(() => { const out = document.getElementById("cn-update-result"); if (out && !out.dataset.painted) { out.dataset.painted = "1"; paintSettingsCard(); } }).observe(document.body, { childList:true, subtree:true });

  window.CastNexusUpdater = { check, get build(){ return build; }, get latest(){ return lastRelease; }, get channel(){ return updateChannel(); }, setChannel:setUpdateChannel, _compareVersion:compareVersion, _channelRelease:channelRelease };
  setTimeout(check, 2500);
  setInterval(check, 6 * 60 * 60 * 1000);
})();
