"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateConsoleProfilesToDiscord } = require("./discord-migration");
const { PROFILE_STORE_SYSTEM } = require("./profile-rtmp");

function makeState() {
  const store = (...profiles) => [{ id:"store", config:{ system:PROFILE_STORE_SYSTEM, activeProfileId:profiles[0].id, profiles } }];
  return { accounts:{
    1:{ twitchUserId:"1", twitchLogin:"nekosunevr", overlays:store(
      { id:"c1", name:"Console Gaming", mode:"console", color:"#ff4fd8", compositorEnabled:true, sceneMusicEnabled:true, destinationEnabledIds:["d1"] },
      { id:"c2", name:"PS5 Nights", mode:"console", color:"#123456", compositorEnabled:true },
      { id:"p1", name:"PC Gaming", mode:"pc" },
    ) },
    2:{ twitchUserId:"2", twitchLogin:"friend", overlays:store({ id:"m1", name:"24/7 Music", mode:"music" }) },
  } };
}
const DISCORD_ONLY = { discordActivity:true, consoleStreaming:false };
const profilesOf = (state, id) => state.accounts[id].overlays[0].config.profiles;

test("converts every Console profile once on a Discord-only install", () => {
  const state = makeState();
  const result = migrateConsoleProfilesToDiscord(state, { features:DISCORD_ONLY, now:new Date("2026-11-22T10:00:00Z") });
  assert.equal(result.ran, true);
  assert.deepEqual(result.converted.map(c => c.profileId), ["c1", "c2"]);
  const [c1, c2, p1] = profilesOf(state, 1);
  assert.deepEqual({ mode:c1.mode, name:c1.name, color:c1.color, compositor:c1.compositorEnabled, music:c1.sceneMusicEnabled, dests:c1.destinationEnabledIds, from:c1.migratedFrom },
    { mode:"discord", name:"Discord Activity", color:"#5865f2", compositor:false, music:false, dests:[], from:"console" });
  assert.equal(c2.mode, "discord"); assert.equal(c2.name, "PS5 Nights", "custom names are kept"); assert.equal(c2.color, "#123456", "custom colours are kept");
  assert.equal(p1.mode, "pc", "other profile types are untouched");
  assert.equal(profilesOf(state, 2)[0].mode, "music");
  assert.deepEqual(state.migrations.consoleToDiscord, { at:"2026-11-22T10:00:00.000Z", converted:2 });
});

test("never runs twice: Console profiles created later are left alone", () => {
  const state = makeState();
  migrateConsoleProfilesToDiscord(state, { features:DISCORD_ONLY });
  profilesOf(state, 1).push({ id:"c3", name:"New console", mode:"console" });
  const again = migrateConsoleProfilesToDiscord(state, { features:DISCORD_ONLY });
  assert.equal(again.ran, false);
  assert.equal(profilesOf(state, 1)[3].mode, "console");
});

test("waits (records nothing) until Discord is on and console streaming is off", () => {
  for (const features of [{ discordActivity:false, consoleStreaming:false }, { discordActivity:true, consoleStreaming:true }]) {
    const state = makeState();
    const result = migrateConsoleProfilesToDiscord(state, { features });
    assert.equal(result.ran, false);
    assert.equal(state.migrations, undefined, "not marked done, so it can run on a later start");
    assert.equal(profilesOf(state, 1)[0].mode, "console");
  }
});
