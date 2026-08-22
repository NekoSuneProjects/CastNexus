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

test("Music 24/7 renders the animated music scene directly", () => {
  const acc = account(null);
  assert.equal(activeProgramScene(acc), null);
  assert.equal(programSceneUrl(acc, profile), musicSceneUrl(acc, profile));
});

test("Program scenes switch the compositor to the direct master scene", () => {
  const live = programSceneUrl(account(null), profile);
  const starting = programSceneUrl(account({ kind: "builtin", name: "startingSoon" }), profile);
  const brb = programSceneUrl(account({ kind: "builtin", name: "brb" }), profile);
  const ending = programSceneUrl(account({ kind: "builtin", name: "ending" }), profile);

  assert.notEqual(starting, live);
  assert.equal(starting, "http://127.0.0.1:8090/overlay/tester/master");
  assert.equal(brb, starting);
  assert.equal(ending, starting);
});

test("Music worker signature changes when entering or leaving Program Scene mode", () => {
  const live = musicWorkerSignature(account(null), profile);
  const starting = musicWorkerSignature(account({ kind: "builtin", name: "startingSoon" }), profile);
  const brb = musicWorkerSignature(account({ kind: "builtin", name: "brb" }), profile);
  const ending = musicWorkerSignature(account({ kind: "builtin", name: "ending" }), profile);

  assert.notEqual(starting, live);
  assert.notEqual(brb, live);
  assert.notEqual(ending, live);
});

test("Music 24/7 defaults to an efficient 3500 Kbps video bitrate", () => {
  const signature=JSON.parse(musicWorkerSignature(account(null),profile));
  assert.equal(signature.video.bitrate,"3500k");
  assert.equal(signature.video.maxrate,"3500k");
  assert.equal(signature.video.bufsize,"7000k");
});
