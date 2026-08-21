"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProfileMusicService } = require("./profile-music");
const { destinationFfmpegArgs } = require("./destination-output");
const { musicSceneFragment } = require("./music-scene");
const { resolveSceneFragment } = require("./overlays");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "castnexus-profile-music-test-"));
const musicDir = path.join(root, "music");
const oldDir = path.join(musicDir, "123");
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, "legacy.mp3"), "fake-audio");

const profileStore = {
  system: "restreamnode-profile-store-v1",
  profiles: [
    { id: "gaming-a", name: "Gaming", mode: "pc", canvasMode: "landscape", sceneMusicEnabled: true },
    { id: "radio-b", name: "Radio", mode: "music", canvasMode: "vertical", sceneMusicEnabled: true },
  ],
  activeProfileId: "gaming-a",
};

const account = {
  twitchUserId: "123",
  twitchLogin: "tester",
  displayName: "Tester",
  overlays: [{ id: "system", type: "html", config: profileStore }],
  overlayConfig: {
    startingSoon: { title: "Starting Soon", accent: "#00f0ff" },
    brb: { title: "BRB", accent: "#00f0ff" },
    ending: { title: "Ending", accent: "#00f0ff" },
    nowPlaying: { enabled: false },
  },
  currentScene: { kind: "builtin", name: "brb" },
  musicTracks: [{ id: "legacy-track", title: "Legacy", artist: "", filename: "legacy.mp3", durationS: 60 }],
  musicSettings: { shuffle: false, loop: true, volume: .42 },
  musicProfiles: {},
};
const state = { accounts: { "123": account } };
let saves = 0;
const fakeEngines = new Map();
const fakeMusicEngine = {
  engineFor(key, getter) {
    if (!fakeEngines.has(key)) fakeEngines.set(key, { ensureRunning(){}, refresh(){}, getNow(){ const a=getter(); return { mode:a.musicTracks.length ? "playing" : "idle", track:a.musicTracks[0] || null, positionS:0, durationS:a.musicTracks[0]?.durationS || 0, volume:a.musicSettings.volume }; } });
    return fakeEngines.get(key);
  },
  async probeDurationSeconds(){ return 1; },
};

const service = createProfileMusicService({
  state,
  saveState(){ saves++; },
  musicDir,
  maxBytes: 1024 * 1024,
  musicEngine: fakeMusicEngine,
  events: { publish(){} },
});

const gaming = service.bucketFor(account, "gaming-a");
assert.equal(gaming.tracks.length, 1, "legacy library should migrate into active profile");
assert.equal(gaming.tracks[0].id, "legacy-track");
assert.equal(gaming.settings.volume, .42);
assert.equal(account.musicTracks.length, 0, "legacy account-global track list should be cleared");
assert.equal(account.musicProfileMigrationDone, true);
assert.equal(fs.existsSync(path.join(musicDir, "123", "gaming-a", "legacy.mp3")), true, "legacy file should move into profile directory");

const radio = service.bucketFor(account, "radio-b");
assert.equal(radio.tracks.length, 0, "second profile must start with a separate library");
assert.equal(service.filePathFor(account, "radio-b", "legacy-track"), null, "other profile must not resolve first profile track ID");
assert.equal(service.filePathFor(account, "gaming-a", "legacy-track"), path.join(musicDir, "123", "gaming-a", "legacy.mp3"));
assert.equal(service.resolveProfile(account, "does-not-exist"), null, "unknown profile must be rejected");
assert.ok(saves > 0);

const now = service.getNow(account, "gaming-a", { respectScene: true });
assert.equal(now.track?.id, "legacy-track", "BRB scene should be allowed to use Gaming profile music");
account.currentScene = null;
assert.equal(service.getNow(account, "gaming-a", { respectScene: true }).mode, "idle", "normal gameplay should not receive standby music");

const brbHtml = resolveSceneFragment({ kind:"builtin", name:"brb" }, account);
assert.match(brbHtml, /music\/gaming-a\?audioOnly=1/, "BRB browser source must embed active profile-specific audio route");
assert.doesNotMatch(brbHtml, /music\/radio-b\?audioOnly=1/, "BRB browser source must not embed another profile");

const verticalScene = musicSceneFragment("tester", {}, { layout:"vertical", audioOnly:"1" }, account, "radio-b");
assert.match(verticalScene, /rn-layout-vertical/);
assert.match(verticalScene, /rn-audio-only/);
assert.match(verticalScene, /\/overlay\/tester\/music\/radio-b/);

const sourceArgs = destinationFfmpegArgs("rtmp://source/live", { url:"rtmp://example/live/key", layout:"source" });
assert.ok(sourceArgs.includes("copy"), "source layout should remain stream-copy");
const verticalArgs = destinationFfmpegArgs("rtmp://source/live", { url:"rtmp://example/live/key2", layout:"vertical" });
assert.ok(verticalArgs.includes("-filter_complex"));
assert.match(verticalArgs[verticalArgs.indexOf("-filter_complex") + 1], /1080:1920/);
assert.ok(verticalArgs.includes("libx264"));

fs.rmSync(root, { recursive: true, force: true });
console.log("profile music isolation + dual-format smoke tests passed");
