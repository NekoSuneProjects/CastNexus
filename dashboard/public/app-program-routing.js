"use strict";

// Program-scene routing is intentionally kept separate from the saved
// compositor preference. A streamer can leave the normal compositor off for
// low CPU usage, switch to Starting Soon / BRB / Ending, and CastNexus will
// temporarily enable the compositor only for the scene. Selecting None restores
// the profile's previous compositor preference and therefore returns to the live
// PC / console / music program.
(function installProgramSceneRouting() {
  const originalSetScene = globalThis.setScene;
  const originalRenderPage = globalThis.renderPage;
  const originalActivateProfile = globalThis.activateProfile;
  const originalSnapshotActiveProfile = globalThis.snapshotActiveProfile;

  if (typeof originalSetScene !== "function" || typeof originalRenderPage !== "function") return;

  function hasProgramScene(scene = globalThis.S?.scene) {
    return Boolean(scene && scene.kind && scene.kind !== "none");
  }

  function preferredCompositor(profile = globalThis.activeProfile?.()) {
    return Boolean(profile && profile.mode !== "music" && profile.compositorEnabled);
  }

  function sceneLabel(scene) {
    if (!scene) return "Live";
    if (scene.kind === "builtin") {
      if (scene.name === "startingSoon") return "Starting Soon";
      if (scene.name === "brb") return "BRB";
      if (scene.name === "ending") return "Ending";
    }
    return scene.kind === "custom" ? "Custom scene" : "Scene";
  }

  async function setRuntimeCompositor(enabled) {
    const result = await globalThis.api("/api/compositor", {
      method: "POST",
      body: { enabled: Boolean(enabled) },
    });
    globalThis.S.compositor = {
      ...(globalThis.S.compositor || {}),
      enabled: Boolean(result?.enabled),
    };
    return globalThis.S.compositor.enabled;
  }

  function syncProgramUi() {
    const state = globalThis.S;
    if (!state) return;
    const profile = globalThis.activeProfile?.();
    const forcedScene = hasProgramScene(state.scene);
    const root = document.getElementById("page-content");

    // A program scene needs the normal compositor for PC / console / rerun
    // profiles. Disable the switch while the temporary override is active so a
    // click cannot accidentally punch through to the raw capture mid-scene.
    const toggle = root?.querySelector("#compositor-toggle");
    if (toggle && forcedScene && profile?.mode !== "music") {
      toggle.checked = true;
      toggle.disabled = true;
      toggle.title = "The active Program Scene temporarily requires the compositor";
    }

    if (state.page !== "overview" || !state.status?.twitchLogin) return;
    const preview = root?.querySelector(".preview-frame iframe");
    if (!preview) return;

    let desired = null;
    const login = encodeURIComponent(state.status.twitchLogin);
    if (profile?.mode === "music") {
      // Music 24/7 renders built-in program scenes in its own worker. The
      // master scene is the closest zero-latency dashboard representation while
      // that worker swaps its output path.
      if (forcedScene) desired = `/overlay/${login}/master`;
    } else if (forcedScene || state.compositor?.enabled) {
      // The compositor browser page is the same visual stack that is encoded
      // into the outgoing composited/<account> RTMP path.
      desired = `/overlay/${login}/compositor`;
    }

    if (desired && preview.getAttribute("src") !== desired) {
      preview.setAttribute("src", desired);
    }
  }

  // Keep the Overview preview honest after every normal page render.
  globalThis.renderPage = function castNexusRenderPageWithProgramPreview() {
    const result = originalRenderPage.apply(this, arguments);
    queueMicrotask(syncProgramUi);
    return result;
  };

  // snapshotActiveProfile normally copies the runtime compositor state into the
  // profile. During a temporary Program Scene override that would accidentally
  // save "true" forever. Preserve the user's stored preference instead.
  if (typeof originalSnapshotActiveProfile === "function") {
    globalThis.snapshotActiveProfile = async function castNexusSnapshotProgramSafe(showToast = false) {
      const profile = globalThis.activeProfile?.();
      const savedPreference = profile?.compositorEnabled;
      const forcedScene = hasProgramScene(globalThis.S?.scene);
      await originalSnapshotActiveProfile.call(this, showToast);
      if (forcedScene && profile && profile.mode !== "music" && profile.compositorEnabled !== savedPreference) {
        profile.compositorEnabled = savedPreference;
        await globalThis.saveProfileStore();
      }
    };
  }

  globalThis.setScene = async function castNexusSetProgramScene(scene) {
    const requested = scene?.kind && scene.kind !== "none" ? scene : { kind: "none" };
    const nextScene = requested.kind === "none" ? null : requested;
    const profile = globalThis.activeProfile?.();

    try {
      // PC / console / rerun scenes must be baked into the outgoing program.
      // Music profiles are handled by music24 itself to avoid mixing the same
      // music track twice through a second compositor.
      if (profile?.mode !== "music" && nextScene) {
        await setRuntimeCompositor(true);
      }

      await globalThis.api("/api/scenes/current", { method: "POST", body: requested });
      globalThis.S.scene = nextScene;

      if (profile) {
        profile.scene = nextScene;
        await globalThis.saveProfileStore();
      }

      if (profile?.mode !== "music" && !nextScene) {
        await setRuntimeCompositor(preferredCompositor(profile));
      } else if (profile?.mode === "music" && globalThis.S.compositor?.enabled) {
        // Music24 already owns the video/audio compositor. Keeping the normal
        // live compositor enabled here would duplicate the music audio path.
        await setRuntimeCompositor(false);
      }

      await globalThis.fetchCore();
      globalThis.renderPage();
      globalThis.toast(nextScene ? `Program: ${sceneLabel(nextScene)}` : "Program: Live capture", "success");
    } catch (error) {
      globalThis.toast(error.message, "error");
      await globalThis.fetchCore().catch(() => {});
      globalThis.renderPage();
    }
  };

  // The existing profile switcher restores scenes only for non-Music profiles.
  // Extend it so Music 24/7 gets its saved Program Scene too, and make sure a
  // saved PC/console scene re-applies its temporary compositor override.
  if (typeof originalActivateProfile === "function") {
    globalThis.activateProfile = async function castNexusActivateProfileWithProgramScene(profileId) {
      await originalActivateProfile.call(this, profileId);
      const profile = globalThis.activeProfile?.();
      if (!profile || profile.id !== profileId) return;

      const savedScene = profile.scene && profile.scene.kind !== "none" ? profile.scene : null;
      try {
        if (profile.mode === "music") {
          await globalThis.api("/api/scenes/current", {
            method: "POST",
            body: savedScene || { kind: "none" },
          });
          globalThis.S.scene = savedScene;
          if (globalThis.S.compositor?.enabled) await setRuntimeCompositor(false);
        } else if (savedScene) {
          await setRuntimeCompositor(true);
        }
        await globalThis.fetchCore();
        globalThis.renderPage();
      } catch (error) {
        globalThis.toast(error.message, "error");
      }
    };
  }

  queueMicrotask(syncProgramUi);
})();
