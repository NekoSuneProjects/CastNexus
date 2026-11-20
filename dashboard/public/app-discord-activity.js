// Settings → Discord Activity. Shows which ONE channel the Discord Activity
// plays and lets the host owner choose it. Everybody else sees it read-only.
(function(){
  "use strict";

  const DOCS = "https://github.com/NekoSuneProjects/CastNexus/blob/docker/docs/DISCORD-ACTIVITY.md";
  const SOURCE_LABELS = { console:"Console", pc:"PC", music:"24/7 Music", rerun:"Rerun" };

  const baseRenderSettings = window.renderSettings;
  window.renderSettings = function renderSettingsWithDiscordActivity() {
    return baseRenderSettings() + `<section class="grid grid-2" style="margin-top:16px"><div class="card-panel" id="discord-activity-panel"><h3>Discord Activity</h3><p class="muted">Loading…</p></div></section>`;
  };

  function badge(data) {
    if (!data.enabled) return `<span class="badge">OFF</span>`;
    if (!data.channelFound) return `<span class="badge">NO CHANNEL</span>`;
    return data.live ? `<span class="badge green">LIVE · ${esc(SOURCE_LABELS[data.source] || "LIVE")}</span>` : `<span class="badge">OFFLINE</span>`;
  }

  function render(panel, data) {
    const title = `<div class="card-title-row"><h3>Discord Activity</h3>${badge(data)}</div>`;
    if (!data.enabled) {
      panel.innerHTML = `${title}<p>Watch this install's stream together inside a Discord voice channel (🚀 Activities). No screen sharing needed, so it works for PS5 / console streams too.</p>
        <div class="callout">Switched off. Set <code>CASTNEXUS_DISCORD_ACTIVITY=true</code> and <code>DISCORD_CLIENT_ID</code> in <code>.env</code>, then restart the container.</div>
        <a class="btn btn-ghost btn-sm" style="margin-top:12px" href="${DOCS}" target="_blank" rel="noopener">Setup guide</a>`;
      return;
    }
    const warn = data.clientIdInvalid
      ? `<div class="callout warn">DISCORD_CLIENT_ID is not a valid Application ID (numbers only). Discord cannot open the Activity until it is fixed.</div>`
      : !data.clientIdSet ? `<div class="callout warn">DISCORD_CLIENT_ID is not set. The page works in a browser, but Discord cannot open it as an Activity yet.</div>` : "";
    const ownerName = data.owner ? `@${esc(data.owner.login)}` : "nobody yet";
    const playing = data.channel ? `<strong>${esc(data.channel)}</strong>${data.channelFound ? "" : " <small class=\"muted\">(has not signed in to this install yet)</small>"}` : "<strong>nothing</strong>";
    let control;
    if (data.lockedByEnv) {
      control = `<div class="callout">Locked by <code>DISCORD_ACTIVITY_CHANNEL</code> in <code>.env</code>.</div>`;
    } else if (data.isOwner) {
      const options = data.choices.map(c => `<option value="${esc(c.login)}" ${c.login === data.channel ? "selected" : ""}>${esc(c.displayName)} (@${esc(c.login)})</option>`).join("");
      control = `<label>Channel the Activity plays</label>
        <div class="copy-field"><select id="da-channel">${options}</select><button class="btn btn-primary btn-sm" id="da-save">Save</button></div>
        <small class="muted">Only Twitch accounts that have signed in to this CastNexus are listed. Viewers can't switch channels and never see anyone else's stream.</small>`;
    } else {
      control = `<div class="callout">Only the host owner (${ownerName}) can change which channel the Activity plays.</div>`;
    }
    panel.innerHTML = `${title}
      <p>Plays ${playing} inside Discord voice channels, from console, PC, Music 24/7 or reruns. No screen sharing needed.</p>
      ${warn}
      ${control}
      <p class="muted" style="margin-top:12px">Host owner: ${ownerName}. Discord URL mapping target: <code>${esc(String(data.pageUrl || "").replace(/^https?:\/\//, "").replace(/\/$/, ""))}</code></p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-ghost btn-sm" href="${esc(data.pageUrl)}" target="_blank" rel="noopener">Open the Activity page</a><a class="btn btn-ghost btn-sm" href="${DOCS}" target="_blank" rel="noopener">Setup guide</a></div>
      <div id="da-error" class="form-error"></div>`;
    const save = panel.querySelector("#da-save");
    if (save) save.onclick = async () => {
      save.disabled = true;
      try {
        const next = await api("/api/discord-activity", { method:"POST", body:{ channel:panel.querySelector("#da-channel").value } });
        render(panel, next);
        toast("Discord Activity channel saved", "success");
      } catch (e) {
        panel.querySelector("#da-error").textContent = e.message;
        save.disabled = false;
      }
    };
  }

  async function load(panel) {
    try { render(panel, await api("/api/discord-activity")); }
    catch (e) { panel.innerHTML = `<h3>Discord Activity</h3><div class="form-error">${esc(e.message)}</div>`; }
  }

  const start = () => new MutationObserver(() => {
    const panel = document.getElementById("discord-activity-panel");
    if (panel && !panel.dataset.loaded) { panel.dataset.loaded = "1"; load(panel); }
  }).observe(document.body, { childList:true, subtree:true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
