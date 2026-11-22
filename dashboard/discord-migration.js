"use strict";

// One-time migration: Console profiles -> Discord Activity profiles.
//
// Runs at server start when the Discord Activity is on and console streaming is
// off (CASTNEXUS_DISCORD_ACTIVITY=true + CASTNEXUS_CONSOLE_STREAMING=false):
// in that setup Console profiles can never go live, while Discord Activity
// profiles capture the same console. Every existing Console profile is turned
// into a Discord Activity profile once. The run is recorded in
// state.migrations.consoleToDiscord, so it never happens again - Console
// profiles created later are left alone. If the conditions aren't met yet,
// nothing is recorded and the migration waits for a later start.

const { PROFILE_STORE_SYSTEM } = require("./profile-rtmp");

const MIGRATION_KEY = "consoleToDiscord";
const CONSOLE_DEFAULT_COLOR = "#ff4fd8";
const DISCORD_COLOR = "#5865f2";

function profileStoreFor(account) {
  return (account?.overlays || []).find(o => o?.config?.system === PROFILE_STORE_SYSTEM)?.config || null;
}

function migrateConsoleProfilesToDiscord(state, { features, now = new Date() } = {}) {
  if (!state || state.migrations?.[MIGRATION_KEY]) return { ran:false, reason:"already done", converted:[] };
  if (!features?.discordActivity || features?.consoleStreaming) return { ran:false, reason:"needs CASTNEXUS_DISCORD_ACTIVITY=true and CASTNEXUS_CONSOLE_STREAMING=false", converted:[] };

  const converted = [];
  for (const account of Object.values(state.accounts || {})) {
    const store = profileStoreFor(account);
    for (const profile of Array.isArray(store?.profiles) ? store.profiles : []) {
      if (profile?.mode !== "console") continue;
      profile.mode = "discord";
      profile.migratedFrom = "console";
      // Discord Activity profiles have no overlays, scene music or destinations.
      profile.compositorEnabled = false;
      profile.sceneMusicEnabled = false;
      profile.destinationEnabledIds = [];
      if (!profile.name || profile.name === "Console Gaming") profile.name = "Discord Activity";
      if (!profile.color || String(profile.color).toLowerCase() === CONSOLE_DEFAULT_COLOR) profile.color = DISCORD_COLOR;
      converted.push({ login:account.twitchLogin || String(account.twitchUserId), profileId:profile.id, name:profile.name });
    }
  }
  state.migrations = { ...(state.migrations || {}), [MIGRATION_KEY]:{ at:now.toISOString(), converted:converted.length } };
  return { ran:true, converted };
}

module.exports = { migrateConsoleProfilesToDiscord, MIGRATION_KEY };
