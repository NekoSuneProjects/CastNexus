// Settings → Discord Activity (+ the same card in Admin) and Settings → Your
// Discord account. The Activity either auto-detects live, Discord-linked
// streamers in the voice channel or plays one channel chosen by the owner.
(function(){
  "use strict";

  const DOCS = "https://github.com/NekoSuneProjects/CastNexus/blob/docker/docs/DISCORD-ACTIVITY.md";
  const SOURCE_LABELS = { console:"Console", pc:"PC", music:"24/7 Music", rerun:"Rerun" };

  // Docker-only: the desktop app has no Discord Activity / Discord account.
  if ((window.CASTNEXUS_BUILD || {}).installType === "electron") return;

  const baseRenderSettings = window.renderSettings;
  window.renderSettings = function renderSettingsWithDiscordActivity() {
    return baseRenderSettings() + `<section class="grid grid-2" style="margin-top:16px">
      <div class="card-panel" id="discord-activity-panel"><h3>Discord Activity</h3><p class="muted">Loading…</p></div>
      <div class="card-panel" id="discord-link-panel"><h3>Your Discord account</h3><p class="muted">Loading…</p></div>
    </section>`;
  };

  function badge(data) {
    if (!data.enabled) return `<span class="badge">OFF</span>`;
    if (data.mode === "auto" && data.autoDetectAvailable) return `<span class="badge green">AUTO</span>`;
    if (!data.channelFound) return `<span class="badge">NO CHANNEL</span>`;
    return data.live ? `<span class="badge green">LIVE · ${esc(SOURCE_LABELS[data.source] || "LIVE")}</span>` : `<span class="badge">OFFLINE</span>`;
  }

  // ------------------------------------------------- Discord Activity card
  function render(panel, data) {
    const title = `<div class="card-title-row"><h3>Discord Activity</h3>${badge(data)}</div>`;
    if (!data.enabled) {
      panel.innerHTML = `${title}<p>Watch streams together inside a Discord voice channel (🚀 Activities). No screen sharing needed, so it works for PS5 / console streams too.</p>
        <div class="callout">Switched off. Set <code>CASTNEXUS_DISCORD_ACTIVITY=true</code> and <code>DISCORD_CLIENT_ID</code> in <code>.env</code>, then restart the container.</div>
        <a class="btn btn-ghost btn-sm" style="margin-top:12px" href="${DOCS}" target="_blank" rel="noopener">Setup guide</a>`;
      return;
    }
    const warn = data.clientIdInvalid
      ? `<div class="callout warn">DISCORD_CLIENT_ID is not a valid Application ID (numbers only). Discord cannot open the Activity until it is fixed.</div>`
      : !data.clientIdSet ? `<div class="callout warn">DISCORD_CLIENT_ID is not set. The page works in a browser, but Discord cannot open it as an Activity yet.</div>` : "";
    const ownerName = data.owner ? `@${esc(data.owner.login)}` : "nobody yet";
    const fallback = data.channel ? `<strong>${esc(data.channel)}</strong>${data.channelFound ? "" : " <small class=\"muted\">(has not signed in to this install yet)</small>"}` : "<strong>nothing</strong>";
    const auto = data.mode === "auto" && data.autoDetectAvailable;
    const howItPlays = auto
      ? `<p><strong>Auto:</strong> plays whoever in the voice channel has linked their Discord account and is live on CastNexus right now (${data.linkedAccounts} linked). If several are live, viewers can switch between them. Nobody live → shows ${fallback}.</p>`
      : `<p>Plays ${fallback} in every Discord voice channel, from console, PC, Music 24/7 or reruns.</p>`;
    const autoHint = !data.autoDetectAvailable
      ? `<div class="callout" style="margin-top:10px">Want it to pick the streamer automatically? Add <code>DISCORD_CLIENT_SECRET</code> to <code>.env</code> and register <code>${esc(data.discordRedirectUri)}</code> under OAuth2 → Redirects in the Discord Developer Portal. Then everyone can link their Discord account here in Settings.</div>`
      : "";
    let control;
    if (data.lockedByEnv) {
      control = `<div class="callout">Locked to <strong>${esc(data.channel || "")}</strong> by <code>DISCORD_ACTIVITY_CHANNEL</code> in <code>.env</code>.</div>`;
    } else if (data.isOwner) {
      const options = data.choices.map(c => `<option value="${esc(c.login)}" ${c.login === data.channel ? "selected" : ""}>${esc(c.displayName)} (@${esc(c.login)})</option>`).join("");
      control = `${data.autoDetectAvailable ? `<label>What the Activity plays</label>
        <select id="da-mode"><option value="auto" ${data.mode === "auto" ? "selected" : ""}>Auto - live, linked streamers in the voice channel</option><option value="fixed" ${data.mode === "fixed" ? "selected" : ""}>Fixed - always the channel below</option></select>` : ""}
        <label>${data.autoDetectAvailable ? "Fallback / fixed channel" : "Channel the Activity plays"}</label>
        <div class="copy-field"><select id="da-channel">${options}</select><button class="btn btn-primary btn-sm" id="da-save">Save</button></div>
        <small class="muted">Only Twitch accounts that have signed in to this CastNexus are listed. People who never linked Discord, or switched it off, are never shown.</small>`;
    } else {
      control = `<div class="callout">Only the host owner (${ownerName}) can change what the Activity plays.</div>`;
    }
    panel.innerHTML = `${title}
      ${howItPlays}
      ${warn}
      ${control}
      ${data.isOwner ? autoHint : ""}
      <p class="muted" style="margin-top:12px">Host owner: ${ownerName}.</p>
      ${(() => { const host = String(data.pageUrl || "").replace(/^https?:\/\//, "").replace(/\/activity\/?$/, "").replace(/\/$/, ""); return `<div class="callout" style="margin-top:8px"><strong>Discord URL Mappings</strong> (Developer Portal → Activities → URL Mappings):<br><code>/</code> → <code>${esc(host)}/activity</code><br><code>/hls</code> → <code>${esc(host)}/hls</code></div>`; })()}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-ghost btn-sm" href="${esc(data.pageUrl)}" target="_blank" rel="noopener">Open the Activity page</a><a class="btn btn-ghost btn-sm" href="${DOCS}" target="_blank" rel="noopener">Setup guide</a></div>
      <div id="da-error" class="form-error"></div>`;
    const save = panel.querySelector("#da-save");
    if (save) save.onclick = async () => {
      save.disabled = true;
      try {
        const body = { channel:panel.querySelector("#da-channel").value };
        const mode = panel.querySelector("#da-mode");
        if (mode) body.mode = mode.value;
        render(panel, await api("/api/discord-activity", { method:"POST", body }));
        toast("Discord Activity saved", "success");
      } catch (e) {
        panel.querySelector("#da-error").textContent = e.message;
        save.disabled = false;
      }
    };
    const modeSelect = panel.querySelector("#da-mode");
    if (modeSelect && save) modeSelect.onchange = () => save.click();
  }

  // ---------------------------------------------- Your Discord account card
  function renderLink(panel, data) {
    const title = `<div class="card-title-row"><h3>Your Discord account</h3>${data.link ? `<span class="badge purple">LINKED</span>` : `<span class="badge">NOT LINKED</span>`}</div>`;
    if (!data.available) {
      panel.innerHTML = `${title}<p class="muted">Discord linking is not set up on this install. The host owner can enable it with <code>DISCORD_CLIENT_SECRET</code> (see the setup guide).</p>`;
      return;
    }
    if (!data.link) {
      panel.innerHTML = `${title}<p>Link your Discord account so the CastNexus <strong>Discord Activity</strong> can find you in a voice channel and show your stream automatically while you're live, from your PS5, PC or anything else.</p>
        <a class="btn btn-primary btn-sm" href="/auth/discord">Link Discord</a>
        <small class="muted" style="display:block;margin-top:8px">Discord only shares your user ID, username and avatar ("identify"). CastNexus keeps no Discord access token.</small>`;
      return;
    }
    const l = data.link;
    panel.innerHTML = `${title}<p>Linked to <strong>${esc(l.globalName || l.username || l.id)}</strong>${l.username ? ` <span class="muted">@${esc(l.username)}</span>` : ""}.</p>
      <div class="card-title-row" style="margin-top:8px"><div><strong>Show me in the Discord Activity when I'm live</strong><br><small class="muted">When off, the Activity never auto-detects or shows your stream.</small></div><label class="toggle"><input id="dl-visible" type="checkbox" ${l.visible ? "checked" : ""}><span class="toggle-track"></span></label></div>
      <div style="display:flex;gap:8px;margin-top:12px"><a class="btn btn-ghost btn-sm" href="/auth/discord">Re-link</a><button class="btn btn-danger btn-sm" id="dl-unlink">Unlink</button></div>
      <div id="dl-error" class="form-error"></div>`;
    panel.querySelector("#dl-visible").onchange = async e => {
      try { renderLink(panel, { ...data, link:(await api("/api/discord/visibility", { method:"POST", body:{ visible:e.target.checked } })).link }); toast(e.target.checked ? "Shown in the Discord Activity when live" : "Hidden from the Discord Activity", "success"); }
      catch (err) { panel.querySelector("#dl-error").textContent = err.message; e.target.checked = !e.target.checked; }
    };
    panel.querySelector("#dl-unlink").onclick = async () => {
      if (!confirm("Unlink your Discord account? The Discord Activity will stop auto-detecting your stream.")) return;
      try { await api("/api/discord/unlink", { method:"POST" }); renderLink(panel, { ...data, link:null }); toast("Discord unlinked", "success"); }
      catch (err) { panel.querySelector("#dl-error").textContent = err.message; }
    };
  }

  async function load(panel) {
    try { render(panel, await api("/api/discord-activity")); }
    catch (e) { panel.innerHTML = `<h3>Discord Activity</h3><div class="form-error">${esc(e.message)}</div>`; }
  }
  async function loadLink(panel) {
    try { renderLink(panel, await api("/api/discord/link")); }
    catch (e) { panel.innerHTML = `<h3>Your Discord account</h3><div class="form-error">${esc(e.message)}</div>`; }
  }

  // Back from /auth/discord.
  function handleReturn() {
    const qs = new URLSearchParams(location.search);
    const result = qs.get("discord");
    if (!result) return;
    const messages = { linked:["Discord account linked", "success"], cancelled:["Discord linking cancelled", "error"], error:["Discord linking failed - try again", "error"] };
    const [text, kind] = messages[result] || messages.error;
    setTimeout(() => toast(text, kind), 300);
    qs.delete("discord"); qs.delete("reason");
    history.replaceState(null, "", location.pathname + (qs.toString() ? `?${qs}` : ""));
  }

  const start = () => {
    handleReturn();
    new MutationObserver(() => {
      const panel = document.getElementById("discord-activity-panel");
      if (panel && !panel.dataset.loaded) { panel.dataset.loaded = "1"; load(panel); }
      const link = document.getElementById("discord-link-panel");
      if (link && !link.dataset.loaded) { link.dataset.loaded = "1"; loadLink(link); }
    }).observe(document.body, { childList:true, subtree:true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
