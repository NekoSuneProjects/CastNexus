"use strict";

(function () {
  const build = window.CASTNEXUS_BUILD || { name:"CastNexus", version:"0.0.0-dev", channel:"dev", installType:"source", repository:"NekoSuneProjects/RestreamNode" };
  let lastRelease = null;
  let notifiedTag = null;

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

  function channelRelease(releases) {
    const clean = (releases || []).filter(r => !r.draft);
    if (build.channel === "beta") return clean[0] || null;
    return clean.find(r => !r.prerelease) || null;
  }

  function updateCommand() {
    if (build.installType === "docker") {
      const beta = build.channel === "beta";
      return `${beta ? "CASTNEXUS_IMAGE_TAG=beta CASTNEXUS_CHANNEL=beta " : "CASTNEXUS_IMAGE_TAG=latest CASTNEXUS_CHANNEL=stable "}docker compose pull && docker compose up -d`;
    }
    return "Download the new CastNexus desktop bundle from the release page, close CastNexus, replace the old files, then start it again.";
  }

  function showUpdate(release) {
    lastRelease = release;
    const tag = release.tag_name || release.name || "new release";
    if (notifiedTag === tag) return;
    notifiedTag = tag;

    const banner = document.createElement("div");
    banner.id = "castnexus-update-banner";
    banner.style.cssText = "position:fixed;right:18px;top:96px;z-index:90;width:min(390px,calc(100vw - 36px));padding:14px;border:1px solid rgba(56,232,255,.22);border-radius:14px;background:rgba(11,15,27,.96);box-shadow:0 20px 55px rgba(0,0,0,.45);backdrop-filter:blur(18px);font-family:Inter,ui-sans-serif,system-ui;color:#f4f6ff";
    banner.innerHTML = `
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="width:38px;height:38px;display:grid;place-items:center;border-radius:11px;background:rgba(56,232,255,.10);color:#38e8ff;border:1px solid rgba(56,232,255,.16);font-weight:900">↑</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:.66rem;letter-spacing:.16em;color:#78839b;font-weight:800">CASTNEXUS UPDATE</div>
          <strong style="display:block;margin-top:3px;font-size:.92rem">${escapeHtml(tag)} is available</strong>
          <div style="font-size:.72rem;color:#8f98af;margin-top:4px">Installed: ${escapeHtml(build.version)} · ${escapeHtml(build.channel)}</div>
          <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap">
            <button id="cn-update-open" style="border:0;border-radius:9px;padding:8px 10px;background:#7c5cff;color:white;font-weight:800;cursor:pointer">View release</button>
            <button id="cn-update-how" style="border:1px solid rgba(255,255,255,.09);border-radius:9px;padding:8px 10px;background:rgba(255,255,255,.03);color:#aab3c7;font-weight:750;cursor:pointer">How to update</button>
            <button id="cn-update-dismiss" style="border:0;background:transparent;color:#687187;cursor:pointer">Dismiss</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(banner);
    banner.querySelector("#cn-update-open").onclick = () => window.open(release.html_url, "_blank", "noopener,noreferrer");
    banner.querySelector("#cn-update-dismiss").onclick = () => banner.remove();
    banner.querySelector("#cn-update-how").onclick = () => {
      if (typeof modalShell === "function") {
        modalShell("Update CastNexus", `${String(build.installType || "install").toUpperCase()} · ${String(build.channel || "stable").toUpperCase()}`, `<p class="muted">A newer CastNexus build is available: <strong>${escapeHtml(tag)}</strong>.</p><div class="code-note">${escapeHtml(updateCommand())}</div><p class="muted">Beta installs follow prereleases. Stable installs only notify for normal releases.</p>`, `<button class="btn btn-ghost" data-modal-close>Close</button><button class="btn btn-primary" id="cn-release-open-modal">Open release</button>`);
        document.querySelectorAll('[data-modal-close]').forEach(b => b.onclick = closeModal);
        const open = document.querySelector("#cn-release-open-modal");
        if (open) open.onclick = () => window.open(release.html_url, "_blank", "noopener,noreferrer");
      } else {
        alert(updateCommand());
      }
    };
    if (typeof toast === "function") toast(`CastNexus ${tag} is available`, "success");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  async function check() {
    if (!parseVersion(build.version) || build.channel === "dev") return;
    try {
      const res = await fetch(`https://api.github.com/repos/${build.repository}/releases?per_page=20`, { headers:{ "Accept":"application/vnd.github+json" }, cache:"no-store" });
      if (!res.ok) return;
      const release = channelRelease(await res.json());
      if (!release?.tag_name) return;
      if (compareVersion(release.tag_name, build.version) > 0) showUpdate(release);
    } catch {}
  }

  window.CastNexusUpdater = { check, get build(){ return build; }, get latest(){ return lastRelease; } };
  setTimeout(check, 2500);
  setInterval(check, 6 * 60 * 60 * 1000);
})();
