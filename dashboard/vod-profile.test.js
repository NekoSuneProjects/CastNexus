"use strict";

// VOD Reruns profiles: a VOD profile publishes as the "rerun" source, and a
// rerun library saved on an older PC profile can be moved into it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProfileVodService } = require("./profile-vod");
const { sourceForProfile, PROFILE_STORE_SYSTEM } = require("./profile-rtmp");

function setup() {
  const vodDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-vod-"));
  const account = {
    twitchUserId:"42",
    overlays:[{ id:"store", config:{ system:PROFILE_STORE_SYSTEM, activeProfileId:"vod1", profiles:[
      { id:"pc1", name:"PC Gaming", mode:"pc" },
      { id:"vod1", name:"VOD Reruns", mode:"vod" },
    ] } }],
    vodProfiles:{
      pc1:{ items:[
        { id:"a", kind:"upload", title:"Old upload", filename:"old.mp4" },
        { id:"b", kind:"youtube", title:"Remote", url:"https://www.youtube.com/watch?v=x" },
      ] },
    },
  };
  const state = { accounts:{ 42:account } };
  let saves = 0;
  const service = createProfileVodService({ state, saveState:() => { saves++; }, vodDir, maxBytes:1e9, probeDurationSeconds:async () => 1 });
  fs.mkdirSync(path.join(vodDir, "42", "pc1"), { recursive:true });
  fs.writeFileSync(path.join(vodDir, "42", "pc1", "old.mp4"), "video");
  return { service, account, vodDir, saves:() => saves };
}

test("a VOD profile publishes as the rerun source", () => {
  assert.equal(sourceForProfile({ mode:"vod" }), "rerun");
  assert.equal(sourceForProfile({ mode:"pc" }), "pc");
});

test("libraries lists profiles with rerun videos", () => {
  const { service, account } = setup();
  assert.deepEqual(service.libraries(account), [{ profileId:"pc1", name:"PC Gaming", mode:"pc", exists:true, items:2 }]);
});

test("moveLibrary moves items and uploaded files into the VOD profile", async () => {
  const { service, account, vodDir, saves } = setup();
  const result = await service.moveLibrary(account, "pc1", "vod1");
  assert.deepEqual(result, { moved:2, toProfileId:"vod1" });
  assert.deepEqual(account.vodProfiles.pc1.items, []);
  assert.deepEqual(account.vodProfiles.vod1.items.map(i => i.id), ["a", "b"]);
  assert.equal(fs.readFileSync(path.join(vodDir, "42", "vod1", "old.mp4"), "utf8"), "video");
  assert.equal(fs.existsSync(path.join(vodDir, "42", "pc1", "old.mp4")), false);
  assert.ok(saves() > 0);
  assert.deepEqual(service.libraries(account).map(l => l.profileId), ["vod1"]);
});

test("moveLibrary refuses bad requests and survives a missing file", async () => {
  const { service, account, vodDir } = setup();
  await assert.rejects(service.moveLibrary(account, "nope", "vod1"), /no VOD library/);
  await assert.rejects(service.moveLibrary(account, "pc1", "pc1"), /same profile/);
  fs.unlinkSync(path.join(vodDir, "42", "pc1", "old.mp4"));
  assert.equal((await service.moveLibrary(account, "pc1", "vod1")).moved, 2);
});
