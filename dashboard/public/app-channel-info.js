// Settings -> Stream info: set the stream title and game/category on Twitch
// and Kick through the CastNexus OAuth broker. Server: channel-info.js
// (/api/channel-info, /auth/channel/:provider).
(function () {
  "use strict";

  const CI = { data:null, picked:{}, searchTimers:{}, loading:false };
  const LABELS = { twitch:"Twitch", kick:"Kick" };
  const COLORS = { twitch:"purple", kick:"green" };

  function card() {
    return `<section class="card-panel" id="cn-stream-info" style="margin-top:16px"><div class="card-title-row"><div><h3>Stream info</h3><p>Set your stream title and game / category on every connected platform at once. Each platform is connected separately through the CastNexus OAuth sign-in.</p></div><button class="btn btn-ghost btn-sm" id="ci-refresh">Refresh</button></div><div id="ci-body"><div class="empty-state"><strong>Loading…</strong></div></div></section>`;
  }

  function platformBlock(conn) {
    const p = conn.provider, cur = CI.data?.current?.[p] || {};
    if (!conn.connected) return `<div class="list-row"><div class="track-icon">${p === "kick" ? "K" : "T"}</div><div class="item-main"><strong>${esc(LABELS[p])}</strong><span>Not connected</span></div><div class="item-actions"><button class="btn btn-primary btn-sm" data-ci-connect="${p}">Connect ${esc(LABELS[p])}</button></div></div>`;
    const picked = CI.picked[p] !== undefined ? CI.picked[p] : cur.category || null;
    return `<div class="card-panel" style="margin-top:10px;padding:14px"><div class="card-title-row"><div><strong>${esc(LABELS[p])}</strong> <span class="badge ${COLORS[p]}">@${esc(conn.login || "connected")}</span></div><div class="item-actions"><label class="check-inline" style="margin:0"><input type="checkbox" data-ci-use="${p}" checked> Update</label><button class="icon-button" data-ci-disconnect="${p}" title="Disconnect ${esc(LABELS[p])}">×</button></div></div>
      ${cur.error ? `<div class="callout warn">${esc(cur.error)}${cur.code === "RECONNECT" ? ` <button class="btn btn-ghost btn-sm" data-ci-connect="${p}">Reconnect</button>` : ""}</div>` : `<div class="stat-sub">Now: <strong>${esc(cur.title || "(no title)")}</strong>${cur.category ? ` · ${esc(cur.category.name)}` : ""}</div>`}
      <div style="margin-top:8px"><label>${p === "twitch" ? "Game / category" : "Category"}</label><div class="copy-field"><input data-ci-search="${p}" placeholder="Search ${esc(LABELS[p])} categories…" value="${esc(picked?.name || "")}"><button class="btn btn-ghost btn-sm" data-ci-clear="${p}" title="Keep the current category">Keep current</button></div><div class="list-stack" data-ci-results="${p}" style="margin-top:6px"></div>${picked && picked !== cur.category ? `<div class="stat-sub">Will set: <strong>${esc(picked.name)}</strong></div>` : ""}</div></div>`;
  }

  function render() {
    const body = document.getElementById("ci-body");
    if (!body) return;
    const conns = CI.data?.connections || [];
    if (!CI.data) { body.innerHTML = `<div class="empty-state"><strong>Loading…</strong></div>`; return; }
    if (CI.data.error) { body.innerHTML = `<div class="callout warn">${esc(CI.data.error)}</div>`; return; }
    const connected = conns.filter(c => c.connected);
    const firstTitle = connected.map(c => CI.data.current?.[c.provider]?.title).find(Boolean) || "";
    body.innerHTML = `${connected.length ? `<div class="full"><label>Stream title</label><input id="ci-title" maxlength="140" value="${esc(document.getElementById("ci-title")?.value ?? firstTitle)}" placeholder="What are you streaming?"><div class="stat-sub">Twitch allows 140 characters, Kick 100 (longer titles are cut).</div></div>` : ""}
      ${conns.map(platformBlock).join("")}
      ${connected.length ? `<div class="page-actions" style="margin-top:12px"><button class="btn btn-primary" id="ci-save">Update stream info</button></div>` : `<div class="stat-sub" style="margin-top:10px">Connect a platform to edit its title and game from here.</div>`}`;
    wire(body);
  }

  function wire(body) {
    body.querySelectorAll("[data-ci-connect]").forEach(b => b.onclick = () => { location.href = `/auth/channel/${encodeURIComponent(b.dataset.ciConnect)}`; });
    body.querySelectorAll("[data-ci-disconnect]").forEach(b => b.onclick = async () => {
      const p = b.dataset.ciDisconnect;
      if (!(await confirmAction(`Disconnect ${LABELS[p]}`, `CastNexus will forget its ${LABELS[p]} sign-in and stop setting the title / game there.`))) return;
      try { await api(`/api/channel-info/${encodeURIComponent(p)}`, { method:"DELETE" }); delete CI.picked[p]; toast(`${LABELS[p]} disconnected`, "success"); load(); } catch (e) { toast(e.message, "error"); }
    });
    body.querySelectorAll("[data-ci-clear]").forEach(b => b.onclick = () => { delete CI.picked[b.dataset.ciClear]; render(); });
    body.querySelectorAll("[data-ci-search]").forEach(input => input.oninput = () => {
      const p = input.dataset.ciSearch;
      clearTimeout(CI.searchTimers[p]);
      CI.searchTimers[p] = setTimeout(() => search(p, input.value), 300);
    });
    const save = document.getElementById("ci-save");
    if (save) save.onclick = () => submit(save);
  }

  async function search(provider, query) {
    const box = document.querySelector(`[data-ci-results="${provider}"]`);
    if (!box) return;
    if (String(query).trim().length < 2) { box.innerHTML = ""; return; }
    try {
      const { items } = await api(`/api/channel-info/categories?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query)}`);
      box.innerHTML = (items || []).slice(0, 8).map(g => `<button class="list-row" style="width:100%;text-align:left;cursor:pointer" data-ci-pick="${esc(g.id)}" data-ci-name="${esc(g.name)}">${g.image ? `<img src="${esc(g.image)}" alt="" style="width:26px;height:36px;object-fit:cover;border-radius:4px">` : `<div class="track-icon">🎮</div>`}<div class="item-main"><strong>${esc(g.name)}</strong></div></button>`).join("") || `<div class="stat-sub">No categories found.</div>`;
      box.querySelectorAll("[data-ci-pick]").forEach(b => b.onclick = () => { CI.picked[provider] = { id:b.dataset.ciPick, name:b.dataset.ciName }; render(); });
    } catch (e) { box.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  }

  async function submit(button) {
    const title = document.getElementById("ci-title")?.value.trim() || "";
    const updates = {};
    document.querySelectorAll("[data-ci-use]").forEach(cb => {
      if (!cb.checked) return;
      const p = cb.dataset.ciUse, change = {};
      if (title) change.title = title;
      if (CI.picked[p]) change.categoryId = CI.picked[p].id;
      if (Object.keys(change).length) updates[p] = change;
    });
    if (!Object.keys(updates).length) return toast("Enter a title or pick a category first", "error");
    button.disabled = true;
    try {
      const r = await fetch("/api/channel-info", { method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ updates }) });
      const { results = {}, error } = await r.json().catch(() => ({}));
      if (error) throw new Error(error);
      const ok = Object.entries(results).filter(([, v]) => v.ok).map(([p, v]) => `${LABELS[p]}${v.truncated ? " (title shortened)" : ""}`);
      const bad = Object.entries(results).filter(([, v]) => !v.ok).map(([p, v]) => `${LABELS[p] || p}: ${v.error}`);
      if (ok.length) toast(`Stream info updated on ${ok.join(", ")}`, "success");
      if (bad.length) toast(bad.join(" · "), "error");
      CI.picked = {};
      await load();
    } catch (e) { toast(e.message, "error"); }
    finally { button.disabled = false; }
  }

  async function load() {
    if (CI.loading) return;
    CI.loading = true;
    try { CI.data = await api("/api/channel-info"); }
    catch (e) { CI.data = { error:e.message }; }
    finally { CI.loading = false; }
    render();
  }

  if (typeof window.renderSettings === "function") {
    const baseRenderSettings = window.renderSettings;
    window.renderSettings = function renderSettingsWithStreamInfo() { return baseRenderSettings() + card(); };
  }
  document.addEventListener("click", e => { if (e.target?.id === "ci-refresh") load(); });
  new MutationObserver(() => {
    const body = document.getElementById("ci-body");
    if (body && !body.dataset.loaded) { body.dataset.loaded = "1"; CI.data = null; load(); }
  }).observe(document.body, { childList:true, subtree:true });

  const params = new URLSearchParams(location.search);
  if (params.get("channel") === "connected") {
    setTimeout(() => { if (typeof toast === "function") toast("Platform connected - you can now set its stream title and game in Settings", "success"); }, 800);
    history.replaceState(null, "", location.pathname);
  }
})();
