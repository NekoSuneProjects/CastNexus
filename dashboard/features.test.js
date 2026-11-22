"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFeatures, _profileModeAllowed, _sourceAllowed, _enabledProfileModes } = require("./features");

test("everything except the Discord Activity is on by default", () => {
  assert.deepEqual({ ...readFeatures({}) }, { music24:true, pcStreaming:true, consoleStreaming:true, vodReruns:true, discordActivity:false });
});

test("switches accept true/false style values and ignore junk", () => {
  const f = readFeatures({ CASTNEXUS_MUSIC24:"false", CASTNEXUS_PC_STREAMING:"OFF", CASTNEXUS_CONSOLE_STREAMING:"maybe", CASTNEXUS_DISCORD_ACTIVITY:"1" });
  assert.equal(f.music24, false);
  assert.equal(f.pcStreaming, false);
  assert.equal(f.consoleStreaming, true);
  assert.equal(f.discordActivity, true);
});

test("profile modes and sources follow their switch; reruns follow the VOD switch", () => {
  const f = readFeatures({ CASTNEXUS_MUSIC24:"false", CASTNEXUS_PC_STREAMING:"false", CASTNEXUS_VOD:"false" });
  assert.equal(_profileModeAllowed("music", f), false);
  assert.equal(_profileModeAllowed("pc", f), false);
  assert.equal(_profileModeAllowed("console", f), true);
  assert.equal(_sourceAllowed("rerun", f), false);
  assert.equal(_sourceAllowed("console", f), true);
  assert.equal(_sourceAllowed("something-new", f), true);
  assert.equal(_profileModeAllowed("vod", f), false);
  assert.deepEqual(_enabledProfileModes(f), ["console"]);
  const pcOff = readFeatures({ CASTNEXUS_PC_STREAMING:"false" });
  assert.equal(_sourceAllowed("rerun", pcOff), true, "reruns no longer depend on PC streaming");
  assert.deepEqual(_enabledProfileModes(pcOff), ["console", "music", "vod"]);
});

test("Discord Activity is Docker-only: always off in the desktop app", () => {
  const { readFeatures } = require("./features");
  assert.equal(readFeatures({ CASTNEXUS_DISCORD_ACTIVITY:"true", CASTNEXUS_INSTALL_TYPE:"electron" }).discordActivity, false);
  assert.equal(readFeatures({ CASTNEXUS_DISCORD_ACTIVITY:"true", CASTNEXUS_INSTALL_TYPE:"docker" }).discordActivity, true);
  assert.equal(readFeatures({ CASTNEXUS_INSTALL_TYPE:"docker" }).discordActivity, false);
});

test("Discord Activity profiles follow the Discord switch, not the console switch (Docker only)", () => {
  const docker = { CASTNEXUS_INSTALL_TYPE:"docker" };
  const consoleOff = readFeatures({ ...docker, CASTNEXUS_CONSOLE_STREAMING:"false", CASTNEXUS_DISCORD_ACTIVITY:"true" });
  assert.equal(_profileModeAllowed("console", consoleOff), false);
  assert.equal(_profileModeAllowed("discord", consoleOff), true);
  assert.equal(_sourceAllowed("discord", consoleOff), true, "console capture still routes for Discord profiles");
  assert.equal(_sourceAllowed("console", consoleOff), false);
  assert.equal(_profileModeAllowed("discord", readFeatures({ ...docker })), false, "off unless CASTNEXUS_DISCORD_ACTIVITY=true");
  assert.equal(_profileModeAllowed("discord", readFeatures({ CASTNEXUS_INSTALL_TYPE:"electron", CASTNEXUS_DISCORD_ACTIVITY:"true" })), false, "never in the desktop app");
});
