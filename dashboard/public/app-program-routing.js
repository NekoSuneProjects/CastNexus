"use strict";

// Program scenes are a live layer inside one long-running render surface.
// PC / Console / rerun profiles keep the compositor alive so switching
// Starting Soon -> BRB -> Ending -> None only changes browser/SSE content;
// it does not tear down FFmpeg or destination pushes. Music 24/7 uses its own
// persistent two-layer program page (music underneath, master scene above).
(function installRealtimeProgramRouting() {
  const originalRenderPage = renderPage;
  const originalActivateProfile = activateProfile;
  let enablingProgramEngine = null;

  function hasProgramScene(scene = S?.scene) {
    return Boolean(scene && scene.kind && scene.kind !== "none");
  }

  function sceneLabel(scene, profile) {
    if (!scene) return profile?.mode === "music" ? "Music scene" : "Live capture";
    if (scene.kind === "builtin") {
      if (scene.name === "startingSoon") return "Starting Soon";
      if (scene.name === "brb") return "BRB";
      if (scene.name === "ending") return "Ending";
    }
    return scene.kind === "custom" ? "Custom scene" : "Scene";
  }

  async function setRuntimeCompositor(enabled) {
    const result = await api("/api/compositor", {
      method: "POST",
      body: { enabled: Boolean(enabled) },
    });
    S.compositor = {
      ...(S.compositor || {}),
      enabled: Boolean(result?.enabled),
    };
    return S.compositor.enabled;
  }

  async function ensureRealtimeProgramEngine(profile = activeProfile?.()) {
    if (!profile || profile.mode === "music") return false;

    // Once a normal live profile owns the Program output, keep its compositor
    // running. None is represented by an empty scene layer over the live WHEP
    // video, not by routing destinations back to raw input.
    if (S.compositor?.enabled) {
      if (profile.compositorEnabled !== true) {
        profile.compositorEnabled = true;
        await saveProfileStore();
      }
      return true;
    }

    if (enablingProgramEngine) return enablingProgramEngine;
    enablingProgramEngine = (async () => {
      await setRuntimeCompositor(true);
      profile.compositorEnabled = true;
      await saveProfileStore();
      return true;
    })().finally(() => { enablingProgramEngine = null; });
    return enablingProgramEngine;
  }

  function musicProgramUrl(profile) {
    if (!profile || !S.status?.twitchLogin) return "";
    const login = encodeURIComponent(S.status.twitchLogin);
    const music = profileMusicUrl(profile);
    const master = `/overlay/${login}/master`;
    const params = new URLSearchParams({ music, master });
    return `/music-program.html?${params.toString()}`;
  }

  function syncProgramUi() {
    const profile = activeProfile?.();
    const root = document.getElementById("page-content");

    const toggle = root?.querySelector("#compositor-toggle");
    if (toggle && profile?.mode !== "music") {
      toggle.checked = true;
      toggle.disabled = true;
      toggle.title = "Realtime Program Scenes keep the compositor running; None shows the live video endpoint";
    }

    if (S.page !== "overview" || !S.status?.twitchLogin || !profile) return;
    const preview = root?.querySelector(".preview-frame iframe");
    if (!preview) return;

    const login = encodeURIComponent(S.status.twitchLogin);
    const desired = profile.mode === "music"
      ? musicProgramUrl(profile)
      : `/overlay/${login}/compositor`;

    if (desired && preview.getAttribute("src") !== desired) {
      preview.setAttribute("src", desired);
    }
  }

  // Every normal live profile uses one persistent compositor as its Program
  // endpoint. Initial activation may start it once, but scene changes never
  // toggle it off/on afterwards.
  renderPage = function castNexusRenderPageWithRealtimeProgram() {
    const result = originalRenderPage.apply(this, arguments);
    queueMicrotask(() => {
      const profile = activeProfile?.();
      if (profile?.mode !== "music") {
        ensureRealtimeProgramEngine(profile).catch(error => toast(error.message, "error"));
      }
      syncProgramUi();
    });
    return result;
  };

  setScene = async function castNexusSetRealtimeProgramScene(scene) {
    const requested = scene?.kind && scene.kind !== "none" ? scene : { kind: "none" };
    const profile = activeProfile?.();

    try {
      if (profile?.mode !== "music") await ensureRealtimeProgramEngine(profile);

      // This is the only runtime scene operation. The server publishes the new
      // fragment over SSE to the already-open browser page. No compositor or
      // destination FFmpeg process is restarted here.
      const result = await api("/api/scenes/current", { method: "POST", body: requested });
      S.scene = result?.currentScene || null;

      if (profile) {
        profile.scene = S.scene;
        await saveProfileStore();
      }

      renderPage();
      toast(`Program: ${sceneLabel(S.scene, profile)}`, "success");
    } catch (error) {
      toast(error.message, "error");
    }
  };

  if (typeof originalActivateProfile === "function") {
    activateProfile = async function castNexusActivateProfileWithRealtimeProgram(profileId) {
      const target = S.profiles.find(profile => profile.id === profileId);

      // Set the preference before the existing profile switcher runs so it
      // starts the Program compositor once instead of disabling it and then
      // immediately starting it again.
      if (target && target.mode !== "music") target.compositorEnabled = true;

      await originalActivateProfile.call(this, profileId);
      const profile = activeProfile?.();
      if (!profile || profile.id !== profileId) return;

      const savedScene = profile.scene && profile.scene.kind !== "none" ? profile.scene : null;
      try {
        if (profile.mode === "music") {
          const result = await api("/api/scenes/current", {
            method: "POST",
            body: savedScene || { kind: "none" },
          });
          S.scene = result?.currentScene || null;
        } else {
          await ensureRealtimeProgramEngine(profile);
        }
        renderPage();
      } catch (error) {
        toast(error.message, "error");
      }
    };
  }

  queueMicrotask(syncProgramUi);
})();
