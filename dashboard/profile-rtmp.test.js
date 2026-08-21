"use strict";

const assert = require("node:assert/strict");
const {
  ensureProfileRtmpKeys,
  activeProfileFor,
  profileById,
  profilePublishPath,
  profileIngestServer,
  profileRtmpInfo,
  matchProfilePath,
  sourceForProfile,
  validRtmpKey,
} = require("./profile-rtmp");

const account = {
  twitchUserId:"123",
  pcKey:"0123456789abcdef01234567",
  overlays:[{
    type:"html",
    config:{
      system:"restreamnode-profile-store-v1",
      activeProfileId:"gaming",
      profiles:[
        { id:"gaming", name:"Gaming", mode:"pc" },
        { id:"radio", name:"Radio", mode:"music" },
      ],
    },
  }],
};

assert.equal(ensureProfileRtmpKeys(account, { legacyKey:account.pcKey }), true);
const gaming = profileById(account,"gaming");
const radio = profileById(account,"radio");
assert.ok(validRtmpKey(gaming.rtmpKey));
assert.ok(validRtmpKey(radio.rtmpKey));
assert.notEqual(gaming.rtmpKey, radio.rtmpKey, "profiles must never share one RTMP key");
assert.equal(gaming.rtmpKey, account.pcKey, "first legacy PC profile keeps the old key during migration");
assert.equal(profileIngestServer("192.168.1.50", gaming), "rtmp://192.168.1.50:1935/profile/gaming");
assert.equal(profilePublishPath(gaming), `profile/gaming/${gaming.rtmpKey}`);
assert.equal(profilePublishPath(radio), `profile/radio/${radio.rtmpKey}`);
assert.deepEqual(matchProfilePath(account, profilePublishPath(gaming))?.profile, gaming);
assert.deepEqual(matchProfilePath(account, profilePublishPath(radio))?.profile, radio);
assert.equal(matchProfilePath(account, `profile/radio/${gaming.rtmpKey}`), null, "one profile key must not authenticate another profile path");
assert.equal(sourceForProfile(gaming), "pc");
assert.equal(sourceForProfile(radio), "music");

const beforeGaming = gaming.rtmpKey;
const beforeRadio = radio.rtmpKey;
account.overlays[0].config.activeProfileId = "radio";
assert.equal(activeProfileFor(account).id, "radio");
assert.equal(ensureProfileRtmpKeys(account, { legacyKey:account.pcKey }), false);
assert.equal(gaming.rtmpKey, beforeGaming, "switching profiles must not rotate another profile's key");
assert.equal(radio.rtmpKey, beforeRadio, "switching profiles must not rotate the selected profile's key");
const info = profileRtmpInfo(account,"castnexus.local","radio");
assert.equal(info.server,"rtmp://castnexus.local:1935/profile/radio");
assert.equal(info.key,radio.rtmpKey);
assert.equal(info.path,profilePublishPath(radio));

console.log("profile RTMP isolation tests passed");
