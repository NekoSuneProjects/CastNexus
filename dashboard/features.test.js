"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFeatures, _profileModeAllowed, _sourceAllowed, _enabledProfileModes } = require("./features");

test("everything except the Discord Activity is on by default", () => {
  assert.deepEqual({ ...readFeatures({}) }, { music24:true, pcStreaming:true, consoleStreaming:true, discordActivity:false });
});

test("switches accept true/false style values and ignore junk", () => {
  const f = readFeatures({ CASTNEXUS_MUSIC24:"false", CASTNEXUS_PC_STREAMING:"OFF", CASTNEXUS_CONSOLE_STREAMING:"maybe", CASTNEXUS_DISCORD_ACTIVITY:"1" });
  assert.equal(f.music24, false);
  assert.equal(f.pcStreaming, false);
  assert.equal(f.consoleStreaming, true);
  assert.equal(f.discordActivity, true);
});

test("profile modes and sources follow their switch; reruns follow PC", () => {
  const f = readFeatures({ CASTNEXUS_MUSIC24:"false", CASTNEXUS_PC_STREAMING:"false" });
  assert.equal(_profileModeAllowed("music", f), false);
  assert.equal(_profileModeAllowed("pc", f), false);
  assert.equal(_profileModeAllowed("console", f), true);
  assert.equal(_sourceAllowed("rerun", f), false);
  assert.equal(_sourceAllowed("console", f), true);
  assert.equal(_sourceAllowed("something-new", f), true);
  assert.deepEqual(_enabledProfileModes(f), ["console"]);
});
