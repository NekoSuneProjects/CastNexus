"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const destinations = require("./profile-destinations");

function accountFixture() {
  return {
    destinations:[
      { id:"yt", name:"YouTube", url:"rtmp://youtube/key", layout:"landscape", enabled:true },
      { id:"tw", name:"Twitch", url:"rtmp://twitch/key", layout:"source", enabled:false },
    ],
    overlays:[{ config:{ system:"restreamnode-profile-store-v1", activeProfileId:"gaming", profiles:[
      { id:"gaming", name:"Gaming", mode:"pc" }, { id:"radio", name:"Radio", mode:"music" },
    ] } }],
  };
}

function select(account, id) { account.overlays[0].config.activeProfileId = id; }

test("legacy destinations migrate to independent profile buckets", () => {
  const account = accountFixture();
  assert.equal(destinations.ensure(account), true);
  destinations.installActiveAccessor(account);
  assert.equal(account.destinations.length, 2);
  account.destinations[0].name = "Gaming YouTube";
  select(account, "radio");
  assert.equal(account.destinations[0].name, "YouTube");
  account.destinations[0].enabled = false;
  select(account, "gaming");
  assert.equal(account.destinations[0].enabled, true);
  assert.equal(account.destinations[0].name, "Gaming YouTube");
});

test("existing server assignment through account.destinations only mutates active profile", () => {
  const account = accountFixture();
  destinations.ensure(account); destinations.installActiveAccessor(account);
  account.destinations = account.destinations.filter(dest => dest.id !== "tw");
  assert.equal(account.destinations.length, 1);
  select(account, "radio");
  assert.equal(account.destinations.length, 2);
});

test("profile created after migration starts with an empty destination list", () => {
  const account = accountFixture();
  destinations.ensure(account); destinations.installActiveAccessor(account);
  account.overlays[0].config.profiles.push({ id:"vertical", name:"Vertical", mode:"pc" });
  assert.equal(destinations.ensure(account), true);
  select(account, "vertical");
  assert.deepEqual(account.destinations, []);
});

test("dynamic destinations accessor is not serialized as a global destination list", () => {
  const account = accountFixture();
  destinations.ensure(account); destinations.installActiveAccessor(account);
  const saved = JSON.parse(JSON.stringify(account));
  assert.equal(Object.hasOwn(saved, "destinations"), false);
  assert.equal(saved.destinationProfiles.gaming.length, 2);
  assert.equal(saved.destinationProfiles.radio.length, 2);
});
