// Discord Activity profiles (Docker only, CASTNEXUS_DISCORD_ACTIVITY=true).
// A console capture whose only output is the Discord Activity. Its Studio is
// trimmed down to: Discord Activity (console capture + stream key + Discord
// link), Profiles, Settings, and Admin for the host owner. Overview, Sources,
// Destinations, Overlay Studio, Music 24/7 and Reruns are hidden.
(function(){
  "use strict";

  PAGE_TITLES.discord = "Discord Activity";
  const ALLOWED_PAGES = new Set(["discord", "profiles", "settings", "admin"]);
  const isDiscordProfile = () => activeProfile()?.mode === "discord";

  function captureLive() { return !!(S.status?.sources?.discord?.live || S.status?.activeSource === "discord"); }

  function renderDiscordPage() {
    const p = activeProfile();
    const live = captureLive();
    const host = S.status?.mediaHost || "";
    const activityUrl = `${location.origin}/activity/`;
    return `
      ${pageHead("DISCORD ACTIVITY", "Discord Activity", `${p?.name || "This profile"} captures your console and plays it only inside Discord voice channels (🚀 Activities). No overlays, music or restream destinations.`)}
      <div class="section-title">Active source configuration</div>
      <section class="grid grid-2">
        <div class="card-panel"><div class="card-title-row"><h3>Console capture</h3><span class="badge ${live ? "green" : ""}" id="dp-capture-badge">${live ? "CONNECTED" : "WAITING"}</span></div>
          <p>Point the console at the CastNexus host for DNS capture. The intercept container is required for reliable Twitch ingest capture.</p>
          <label>CastNexus / DNS host</label><div class="copy-field"><input readonly value="${esc(host)}"><button class="btn btn-ghost btn-sm" data-copy="${esc(host)}">Copy</button></div>
          <label>Twitch key</label><div class="code-note">${esc(S.status?.streamKeyMasked || "Not configured")}</div>
        </div>
        <div class="card-panel"><h3>Console Twitch stream key</h3>
          <p>The saved key is masked and never returned in full. Import it from Twitch with OAuth2 or enter it manually - do this again if you reset your key on Twitch.</p>
          <button class="btn btn-primary btn-sm" data-action="change-stream-key">${S.status?.streamKeyMasked ? "Change stream key" : "Add stream key"}</button>
        </div>
      </section>
      <section class="grid grid-2" style="margin-top:16px">
        <div class="card-panel" id="discord-link-panel"><h3>Your Discord account</h3><p class="muted">Loading…</p></div>
        <div class="card-panel"><div class="card-title-row"><h3>In Discord</h3><span class="badge ${live ? "green" : ""}" id="dp-live-badge">${live ? "LIVE IN THE ACTIVITY" : "OFFLINE"}</span></div>
          <p>Join a voice channel in Discord, press <strong>🚀 Activities</strong> and open the CastNexus app. Your stream plays there as soon as the console is live.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-ghost btn-sm" href="${esc(activityUrl)}" target="_blank" rel="noopener">Preview the Activity page</a><button class="btn btn-ghost btn-sm" data-nav="settings">Activity settings</button></div>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------- render
  const baseRenderPage = renderPage;
  renderPage = function renderPageWithDiscordProfile() {
    if (isDiscordProfile() && !ALLOWED_PAGES.has(S.page)) S.page = "discord";
    if (S.page === "discord" && !isDiscordProfile()) S.page = "overview";
    if (S.page !== "discord") { baseRenderPage(); syncNav(); return; }
    const root = $("#page-content");
    if (!root) return;
    $("#page-title").textContent = PAGE_TITLES.discord;
    stopMusicNowPolling();
    root.innerHTML = renderDiscordPage();
    wirePage();
    syncNav();
  };

  // ---------------------------------------------------------------- nav
  function syncNav() {
    const nav = document.getElementById("main-nav");
    if (!nav) return;
    const discord = isDiscordProfile();
    let item = nav.querySelector('[data-page="discord"]');
    if (discord && !item) {
      item = document.createElement("button");
      item.className = "nav-item";
      item.dataset.page = "discord";
      item.innerHTML = "<span>◉</span>Discord Activity";
      nav.prepend(item);
    }
    if (item) item.hidden = !discord;
    nav.querySelectorAll(".nav-item[data-page]").forEach(el => {
      const page = el.dataset.page;
      if (page === "discord") return;
      if (discord && !ALLOWED_PAGES.has(page)) { el.hidden = true; el.dataset.discordHidden = "1"; }
      else if (!discord && el.dataset.discordHidden) { el.hidden = false; delete el.dataset.discordHidden; }
    });
    $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === S.page));
  }

  // Profile switches, first load and live status changes.
  let lastMode = null;
  setInterval(() => {
    if (!S.profiles) return;
    const mode = activeProfile()?.mode || null;
    if (mode !== lastMode) {
      lastMode = mode;
      syncNav();
      if ((mode === "discord" && !ALLOWED_PAGES.has(S.page)) || (mode !== "discord" && S.page === "discord")) renderPage();
    }
    if (S.page === "discord") {
      const live = captureLive();
      const a = $("#dp-capture-badge"), b = $("#dp-live-badge");
      if (a) { a.className = `badge ${live ? "green" : ""}`; a.textContent = live ? "CONNECTED" : "WAITING"; }
      if (b) { b.className = `badge ${live ? "green" : ""}`; b.textContent = live ? "LIVE IN THE ACTIVITY" : "OFFLINE"; }
    }
  }, 700);
})();
