"use strict";

const assert = require("node:assert/strict");
const { engineFor } = require("./music-engine");

function track(id, durationS = 120) {
  return { id, title:id.toUpperCase(), artist:"Tester", durationS };
}

const account = {
  musicTracks:[track("first")],
  musicSettings:{ shuffle:false, loop:true, volume:.7 },
};

const events=[];
const engine = engineFor(`playlist-growth-${Date.now()}`, () => account, (now) => events.push(now));
engine.ensureRunning();
assert.equal(engine.getNow().track.id, "first");

// Reproduce the reported bug: another song is uploaded after playback already
// started. The old engine retained playOrder=[0] and looped first forever.
account.musicTracks.push(track("second"));
engine.refresh();
assert.equal(engine.getNow().track.id, "first", "adding a track must not restart the current song");
assert.deepEqual(engine.playOrder, ["first", "second"], "playlist order must include the newly uploaded track");

engine._advance();
assert.equal(engine.getNow().track.id, "second", "finishing the first song must advance to the newly uploaded second song");

engine._advance();
assert.equal(engine.getNow().track.id, "first", "looping a non-shuffled two-track playlist should return to the first song only after the second finishes");

// Removing the current song should move playback to a valid remaining song.
account.musicTracks = [track("second"), track("third")];
engine.refresh();
assert.ok(["second", "third"].includes(engine.getNow().track.id));

// Toggling shuffle while a song is playing must keep the current track but
// rebuild upcoming order using all tracks.
const beforeShuffle = engine.getNow().track.id;
account.musicSettings.shuffle = true;
engine.refresh();
assert.equal(engine.getNow().track.id, beforeShuffle);
assert.equal(new Set(engine.playOrder).size, 2);
assert.ok(engine.playOrder.includes("second") && engine.playOrder.includes("third"));

engine.stop();
assert.ok(events.length >= 3);
console.log("music engine playlist growth + advancement tests passed");
