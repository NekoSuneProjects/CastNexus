// Admin dashboard (host owner only): install health, feature switches,
// accounts (block / sign out / stop / remove), Discord Activity, legal pages
// and the admin audit log. Server side: dashboard/admin.js (/api/admin/*).
(function(){
  "use strict";

  PAGE_TITLES.admin = "Admin";
  const SOURCE_LABELS = { console:"Console", pc:"PC / OBS", music:"24/7 Music", rerun:"Rerun" };
  const FEATURE_ROWS = [
    ["music24", "Music 24/7 radio", "CASTNEXUS_MUSIC24"],
    ["pcStreaming", "PC / OBS streaming", "CASTNEXUS_PC_STREAMING"],
    ["consoleStreaming", "Console streaming", "CASTNEXUS_CONSOLE_STREAMING"],
    ["vodReruns", "VOD reruns", "CASTNEXUS_VOD"],
    ["discordActivity", "Discord Activity", "CASTNEXUS_DISCORD_ACTIVITY"],
  ];
  const A = { users:[], overview:null };

  // ------------------------------------------------------------- nav item
  function syncNav() {
    const nav = document.getElementById("main-nav");
    if (!nav) return;
    let item = nav.querySelector('[data-page="admin"]');
    const owner = !!S.status?.isOwner;
    if (owner && !item) {
      item = document.createElement("button");
      item.className = "nav-item";
      item.dataset.page = "admin";
      item.innerHTML = "<span>⛨</span>Admin";
      const settings = nav.querySelector('[data-page="settings"]');
      settings ? settings.after(item) : nav.appendChild(item);
    }
    if (item) item.hidden = !owner;
    if (!owner && S.page === "admin") navigate("overview");
  }
  setInterval(syncNav, 1500);

  // ---------------------------------------------------------- page render
  const baseRenderPage = renderPage;
  renderPage = function renderPageWithAdmin() {
    if (S.page !== "admin") return baseRenderPage();
    const root = $("#page-content");
    if (!root) return;
    $("#page-title").textContent = PAGE_TITLES.admin;
    $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === "admin"));
    stopMusicNowPolling();
    root.innerHTML = `
      ${pageHead("HOST OWNER", "Admin", "Everything about this CastNexus install: health, who can sign in, accounts, Discord Activity and the public legal pages.", `<button class="btn btn-ghost" id="adm-refresh">Refresh</button>`)}
      <section class="grid grid-4" id="adm-stats"><div class="card-panel stat-card"><div class="stat-label">Loading</div><div class="stat-value">…</div></div></section>
      <section class="grid grid-2" style="margin-top:16px">
        <div class="card-panel" id="adm-access"><h3>Sign-in &amp; features</h3><p class="muted">Loading…</p></div>
        <div class="card-panel" id="discord-activity-panel"><h3>Discord Activity</h3><p class="muted">Loading…</p></div>
      </section>
      <div class="section-title">Accounts</div>
      <section class="card-panel" id="adm-users"><p class="muted">Loading…</p></section>
      <section class="grid grid-2" style="margin-top:16px">
        <div class="card-panel" id="adm-legal"><h3>Privacy Policy &amp; Terms</h3><p class="muted">Loading…</p></div>
        <div class="card-panel" id="adm-audit"><h3>Admin log</h3><p class="muted">Loading…</p></div>
      </section>`;
    $("#adm-refresh").onclick = () => loadAll();
    loadAll();
  };

  async function loadAll() {
    try {
      const [overview, users, legal, audit] = await Promise.all([
        api("/api/admin/overview"), api("/api/admin/users"), api("/api/admin/legal"), api("/api/admin/audit"),
      ]);
      if (S.page !== "admin") return;
      A.overview = overview; A.users = users.users || [];
      renderStats(overview); renderAccess(overview); renderUsers(); renderLegal(legal.legal || {}); renderAudit(audit.entries || []);
    } catch (e) {
      const root = $("#page-content");
      if (root && S.page === "admin") root.innerHTML = `${pageHead("HOST OWNER", "Admin", "")}<div class="callout warn">${esc(e.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------- stats
  const fmtBytes = b => b == null ? "—" : b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
  function fmtUptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleString(undefined, { dateStyle:"medium", timeStyle:"short" });
  }
  function stat(label, value, sub) {
    return `<div class="card-panel stat-card"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-sub">${esc(sub || "")}</div></div>`;
  }
  function renderStats(o) {
    const host = o.host || {};
    const ram = host.ramTotalBytes ? `${fmtBytes(host.ramUsedBytes)} / ${fmtBytes(host.ramTotalBytes)}` : "—";
    $("#adm-stats").innerHTML = [
      stat("Accounts", String(o.accounts.total), `${o.accounts.blocked} blocked`),
      stat("Live now", String(o.accounts.live), o.accounts.live ? "streams routed" : "nobody streaming"),
      stat("Host CPU", host.cpuPercent == null ? "—" : `${Math.round(host.cpuPercent)}%`, `RAM ${ram}`),
      stat("CastNexus", o.build.version, `${o.build.channel} · ${o.build.installType} · up ${fmtUptime(o.uptimeSeconds)}`),
    ].join("");
  }

  // ----------------------------------------------------- access & features
  function renderAccess(o) {
    const reg = o.registration;
    const regBadge = reg.mode === "open" ? `<span class="badge yellow">OPEN</span>` : reg.mode === "closed" ? `<span class="badge green">CLOSED</span>` : `<span class="badge green">ALLOW-LIST</span>`;
    const features = FEATURE_ROWS.map(([key, label, env]) => `<div class="list-row" style="display:flex;align-items:center;gap:10px;margin-top:8px"><div class="item-main"><strong>${esc(label)}</strong><span><code>${env}</code></span></div><span class="badge ${o.features[key] ? "green" : ""}">${o.features[key] ? "ON" : "OFF"}</span></div>`).join("");
    $("#adm-access").innerHTML = `<div class="card-title-row"><h3>Sign-in &amp; features</h3>${regBadge}</div>
      <p>${esc(reg.label)}.</p>
      <p class="muted">Host owner: <strong>@${esc(o.owner?.login || "—")}</strong> (set by ${esc(o.owner?.source || "—")}). Video encoder: ${esc(o.encoder?.label || "—")}${o.encoder?.hardware ? " (hardware)" : ""}.</p>
      ${reg.mode === "open" ? `<div class="callout warn">Anyone with a Twitch account can create an account here. On a public server, set <code>ALLOWED_TWITCH_LOGINS</code> or <code>DISABLE_REGISTRATION=true</code> in <code>.env</code>.</div>` : ""}
      ${features}
      <small class="muted" style="display:block;margin-top:10px">Feature switches and sign-in rules are set in the server's <code>.env</code> and need a container restart to change.</small>`;
  }

  // ---------------------------------------------------------------- users
  function userRow(u) {
    const avatar = u.profileImageUrl ? `<img class="avatar" src="${esc(u.profileImageUrl)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar"></div>`;
    const badges = [
      u.isOwner ? `<span class="badge purple">OWNER</span>` : "",
      u.blocked ? `<span class="badge yellow">BLOCKED</span>` : "",
      u.live ? `<span class="badge green">LIVE · ${esc(SOURCE_LABELS[u.live] || u.live)}</span>` : `<span class="badge">OFFLINE</span>`,
      u.activeProfile ? `<span class="badge">${esc(u.activeProfile.name || "Profile")} · ${esc(MODE_LABELS[u.activeProfile.mode] || u.activeProfile.mode || "")}</span>` : "",
      u.streamKey.set ? `<span class="badge cyan">STREAM KEY · ${u.streamKey.source === "oauth" ? "TWITCH" : "MANUAL"}</span>` : "",
      `<span class="badge">${u.destinations.enabled}/${u.destinations.total} OUTPUTS</span>`,
    ].join("");
    const actions = [
      u.live ? `<button class="btn btn-ghost btn-sm" data-adm="stop" data-id="${esc(u.id)}">Stop stream</button>` : "",
      u.isOwner ? "" : `<button class="btn btn-ghost btn-sm" data-adm="sign-out" data-id="${esc(u.id)}">Sign out</button>`,
      u.isOwner ? "" : `<button class="btn btn-ghost btn-sm" data-adm="${u.blocked ? "unblock" : "block"}" data-id="${esc(u.id)}">${u.blocked ? "Unblock" : "Block"}</button>`,
      u.isOwner ? "" : `<button class="btn btn-danger btn-sm" data-adm="remove" data-id="${esc(u.id)}">Remove</button>`,
    ].join("");
    return `<div class="list-row" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px">
      ${avatar}
      <div class="item-main" style="min-width:200px;flex:1"><strong>${esc(u.displayName)}</strong><span>@${esc(u.login || u.id)} · joined ${esc(fmtDate(u.createdAt))} · last sign-in ${esc(fmtDate(u.lastLoginAt))}</span><div class="profile-meta" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${badges}</div></div>
      <div class="item-actions" style="display:flex;gap:6px;flex-wrap:wrap">${actions}</div>
    </div>`;
  }
  function renderUsers() {
    const box = $("#adm-users");
    box.innerHTML = `<div class="card-title-row"><h3>${A.users.length} account${A.users.length === 1 ? "" : "s"}</h3><input id="adm-search" placeholder="Search login or name" style="max-width:260px"></div><div id="adm-user-list"></div>`;
    const draw = () => {
      const q = ($("#adm-search").value || "").trim().toLowerCase();
      const rows = A.users.filter(u => !q || String(u.login || "").includes(q) || String(u.displayName || "").toLowerCase().includes(q));
      $("#adm-user-list").innerHTML = rows.length ? rows.map(userRow).join("") : `<p class="muted">No matching accounts.</p>`;
      $$("[data-adm]", box).forEach(b => b.onclick = () => userAction(b.dataset.adm, A.users.find(u => u.id === b.dataset.id)));
    };
    $("#adm-search").oninput = draw;
    draw();
  }

  async function userAction(action, u) {
    if (!u) return;
    try {
      if (action === "remove") return confirmRemove(u);
      if (action === "block" && !confirm(`Block @${u.login}? They are signed out, their stream stops being routed and they can't sign in until unblocked.`)) return;
      if (action === "sign-out" && !confirm(`Sign @${u.login} out of every browser?`)) return;
      if (action === "stop" && !confirm(`Stop routing @${u.login}'s current stream? Outputs stay off until that broadcast ends; their next broadcast works normally.`)) return;
      const path = action === "block" || action === "unblock" ? "block" : action;
      await api(`/api/admin/users/${encodeURIComponent(u.id)}/${path}`, { method:"POST", body:action === "block" ? { blocked:true } : action === "unblock" ? { blocked:false } : {} });
      toast({ block:"Account blocked", unblock:"Account unblocked", "sign-out":"Signed out everywhere", stop:"Stream stopped" }[action], "success");
      loadAll();
    } catch (e) { toast(e.message, "error"); }
  }

  function confirmRemove(u) {
    modalShell("Remove account", "ADMIN", `<p>This removes <strong>@${esc(u.login)}</strong> from this install: profiles, destinations, scenes, stream key and settings. Uploaded files stay on disk under <code>data/</code> until you delete them.</p><p class="muted">If registration is open they can sign in again as a new, empty account. Use <strong>Block</strong> to keep them out.</p><label>Type <code>${esc(u.login)}</code> to confirm</label><input id="adm-remove-confirm" autocomplete="off"><div id="modal-error" class="form-error"></div>`,
      `<button class="btn btn-ghost" data-modal-close>Cancel</button><button class="btn btn-danger" id="adm-remove-go">Remove account</button>`);
    $$("[data-modal-close]").forEach(b => b.onclick = closeModal);
    $("#adm-remove-go").onclick = async () => {
      try {
        await api(`/api/admin/users/${encodeURIComponent(u.id)}`, { method:"DELETE", body:{ confirm:$("#adm-remove-confirm").value.trim() } });
        closeModal(); toast("Account removed", "success"); loadAll();
      } catch (e) { $("#modal-error").textContent = e.message; }
    };
  }

  // ---------------------------------------------------------------- legal
  function renderLegal(legal) {
    const origin = location.origin;
    $("#adm-legal").innerHTML = `<h3>Privacy Policy &amp; Terms</h3>
      <p>Public pages for this install. Use these URLs in the Discord Developer Portal (General Information → Privacy Policy URL / Terms of Service URL).</p>
      <div class="copy-field"><input readonly value="${esc(origin)}/privacy"><button class="btn btn-ghost btn-sm" data-copy="${esc(origin)}/privacy">Copy</button><a class="btn btn-ghost btn-sm" href="/privacy" target="_blank" rel="noopener">Open</a></div>
      <div class="copy-field" style="margin-top:8px"><input readonly value="${esc(origin)}/terms"><button class="btn btn-ghost btn-sm" data-copy="${esc(origin)}/terms">Copy</button><a class="btn btn-ghost btn-sm" href="/terms" target="_blank" rel="noopener">Open</a></div>
      <label>Operator name (who runs this server)</label><input id="adm-op-name" maxlength="120" value="${esc(legal.operatorName || "")}" placeholder="e.g. NekoSuneVR">
      <label>Contact URL</label><input id="adm-op-url" value="${esc(legal.contactUrl || "")}" placeholder="https://…">
      <label>Contact email</label><input id="adm-op-email" value="${esc(legal.contactEmail || "")}" placeholder="privacy@example.com">
      <button class="btn btn-primary btn-sm" id="adm-legal-save" style="margin-top:12px">Save</button>
      <div id="adm-legal-error" class="form-error"></div>`;
    $$("[data-copy]", $("#adm-legal")).forEach(b => b.onclick = () => copyText(b.dataset.copy));
    $("#adm-legal-save").onclick = async () => {
      try {
        await api("/api/admin/legal", { method:"PUT", body:{ operatorName:$("#adm-op-name").value, contactUrl:$("#adm-op-url").value, contactEmail:$("#adm-op-email").value } });
        toast("Legal page details saved", "success");
        loadAll();
      } catch (e) { $("#adm-legal-error").textContent = e.message; }
    };
  }

  // ---------------------------------------------------------------- audit
  const AUDIT_LABELS = { block:"blocked", unblock:"unblocked", "sign-out":"signed out", "stop-outputs":"stopped the stream of", "remove-account":"removed", "update-legal":"updated the legal page details" };
  function renderAudit(entries) {
    $("#adm-audit").innerHTML = `<h3>Admin log</h3>${entries.length ? entries.slice(0, 25).map(e => `<div class="list-row" style="margin-top:6px"><strong>@${esc(e.by)}</strong> ${esc(AUDIT_LABELS[e.action] || e.action)} ${e.target ? `<strong>@${esc(e.target)}</strong>` : ""}<br><small class="muted">${esc(fmtDate(e.at))}</small></div>`).join("") : `<p class="muted">No admin actions yet.</p>`}`;
  }
})();
