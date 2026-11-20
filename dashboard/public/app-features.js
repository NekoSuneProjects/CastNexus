// Install-wide feature switches (CASTNEXUS_MUSIC24 / CASTNEXUS_PC_STREAMING /
// CASTNEXUS_CONSOLE_STREAMING in the Docker .env). The server already refuses
// switched-off sources; this hides them in the Studio so nobody creates a
// profile that can never go live.
(function(){
  "use strict";

  const features = window.CASTNEXUS_FEATURES || {};
  const MODES = ["pc", "console", "music"];
  const ENV_NAMES = { pc:"CASTNEXUS_PC_STREAMING", console:"CASTNEXUS_CONSOLE_STREAMING", music:"CASTNEXUS_MUSIC24" };
  const allowedModes = Array.isArray(features.profileModes) ? features.profileModes.filter(m => MODES.includes(m)) : MODES;
  const disabledModes = MODES.filter(m => !allowedModes.includes(m));
  window.castnexusModeAllowed = mode => !MODES.includes(mode) || allowedModes.includes(mode);
  if (!disabledModes.length) return;

  const fallbackMode = allowedModes[0] || "pc";
  const label = mode => (typeof MODE_LABELS === "object" && MODE_LABELS[mode]) || mode;

  // New profiles (first-run and the "+" buttons) never use a disabled mode.
  const originalCreateProfile = window.createProfile;
  if (typeof originalCreateProfile === "function") {
    window.createProfile = function(mode, name) {
      if (window.castnexusModeAllowed(mode)) return originalCreateProfile(mode, name);
      const fallbackName = fallbackMode === "pc" ? "PC Gaming" : fallbackMode === "console" ? "Console Gaming" : "24/7 Music";
      return originalCreateProfile(fallbackMode, fallbackName);
    };
  }

  function prune(root) {
    for (const mode of disabledModes) {
      root.querySelectorAll(`[data-setup-mode="${mode}"], [data-add-profile-mode="${mode}"]`).forEach(el => el.remove());
      root.querySelectorAll(`[data-create-or-switch-mode="${mode}"]`).forEach(el => (el.closest(".card-panel") || el).remove());
      root.querySelectorAll(`#pf-mode option[value="${mode}"]`).forEach(el => el.remove());
    }
    const modeSelect = root.querySelector("#pf-mode");
    if (modeSelect && !modeSelect.value) modeSelect.value = fallbackMode;
    noteActiveProfile(root);
  }

  // The active profile was created before its mode was switched off.
  function noteActiveProfile(root) {
    const page = root.querySelector ? root.querySelector("#page-content") : null;
    if (!page || page.querySelector(".feature-off-note")) return;
    const profile = typeof activeProfile === "function" ? activeProfile() : null;
    if (!profile || window.castnexusModeAllowed(profile.mode)) return;
    const note = document.createElement("div");
    note.className = "callout warn feature-off-note";
    note.style.marginBottom = "12px";
    note.textContent = `${label(profile.mode)} is switched off on this server (${ENV_NAMES[profile.mode]}=false), so the "${profile.name}" profile cannot go live. Switch to another profile, or turn the feature back on in .env and restart the container.`;
    page.prepend(note);
  }

  const start = () => {
    prune(document);
    new MutationObserver(() => prune(document)).observe(document.body, { childList:true, subtree:true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
