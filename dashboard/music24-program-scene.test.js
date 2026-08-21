"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  musicSceneUrl,
  activeProgramScene,
  programSceneUrl,
  musicWorkerSignature,
} = require("./music24");

function account(scene = null) {
  return {
    twitchUserId: "123",
    twitchLogin: "tester",
    currentScene: scene,
  };
}

const profile = {
  id: "radio",
  mode: "music",
  canvasMode: "landscape",
  rtmpKey: "0123456789abcdef0123456789abcdef0123",
  musicVisual: {
    accent: "#00f0ff",
    station: "Test Radio",
    title: "Test Radio",
  },
};

test("Music 24/7 uses spectrum scene while Program Scene is None", () => {
  const acc = account(null);
  assert.equal(activeProgramScene(acc), null);
  assert.equal(programSceneUrl(acc, profile), musicSceneUrl(acc, profile));
  assert.match(programSceneUrl(acc, profile), /\/overlay\/tester\/music\/radio/);
});

test("Music 24/7 switches its existing renderer to master Program Scene", () => {
  const acc = account({ kind: "builtin", name: "startingSoon" });
  assert.deepEqual(activeProgramScene(acc), { kind: "builtin", name: "startingSoon" });
  assert.match(programSceneUrl(acc, profile), /\/overlay\/tester\/master$/);
});

test("switching between built-in scenes keeps master worker signature stable", () => {
  const starting = musicWorkerSignature(account({ kind: "builtin", name: "startingSoon" }), profile);
  const brb = musicWorkerSignature(account({ kind: "builtin", name: "brb" }), profile);
  const ending = musicWorkerSignature(account({ kind: "builtin", name: "ending" }), profile);
  const live = musicWorkerSignature(account(null), profile);

  assert.equal(starting, brb);
  assert.equal(brb, ending);
  assert.notEqual(starting, live, "entering/leaving Program Scene mode should restart renderer once");
});
