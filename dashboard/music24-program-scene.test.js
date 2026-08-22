"use strict";

const fs = require("node:fs");
const path = require("node:path");
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

test("Music 24/7 permanent Program page contains music and master layers", () => {
  const acc = account(null);
  assert.equal(activeProgramScene(acc), null);

  const url = new URL(programSceneUrl(acc, profile));
  assert.equal(url.pathname, "/music-program.html");
  assert.equal(url.searchParams.get("music"), musicSceneUrl(acc, profile));
  assert.equal(url.searchParams.get("master"), "http://127.0.0.1:8090/overlay/tester/master");

  const shell = fs.readFileSync(path.join(__dirname, "public", "music-program.html"), "utf8");
  assert.match(shell, /id="music-layer"/);
  assert.match(shell, /id="scene-layer"/);
  assert.match(shell, /url\.origin !== location\.origin/);
  assert.match(shell, /url\.pathname\.startsWith\("\/overlay\/"\)/);
});

test("Program page URL never changes when Music scene changes", () => {
  const live = programSceneUrl(account(null), profile);
  const starting = programSceneUrl(account({ kind: "builtin", name: "startingSoon" }), profile);
  const brb = programSceneUrl(account({ kind: "builtin", name: "brb" }), profile);
  const ending = programSceneUrl(account({ kind: "builtin", name: "ending" }), profile);

  assert.equal(starting, live);
  assert.equal(brb, live);
  assert.equal(ending, live);
});

test("Music worker signature is identical for None, Starting Soon, BRB and Ending", () => {
  const live = musicWorkerSignature(account(null), profile);
  const starting = musicWorkerSignature(account({ kind: "builtin", name: "startingSoon" }), profile);
  const brb = musicWorkerSignature(account({ kind: "builtin", name: "brb" }), profile);
  const ending = musicWorkerSignature(account({ kind: "builtin", name: "ending" }), profile);

  assert.equal(starting, live, "entering Program Scene mode must not restart Music24");
  assert.equal(brb, live, "BRB must stay on the same Music24 worker");
  assert.equal(ending, live, "Ending must stay on the same Music24 worker");
});

test("Music 24/7 defaults to an efficient 3500 Kbps video bitrate", () => {
  const signature=JSON.parse(musicWorkerSignature(account(null),profile));
  assert.equal(signature.video.bitrate,"3500k");
  assert.equal(signature.video.maxrate,"3500k");
  assert.equal(signature.video.bufsize,"7000k");
});
