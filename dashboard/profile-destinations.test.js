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
    overlays:[{
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
}

test("legacy global destinations are cloned into every existing profile once", () => {
  const account = accountFixture();
  assert.equal(destinations.ensure(account), true);
  assert.equal(account.destinations.length, 0);
  assert.equal(destinations.destinationsFor(account, "gaming").length, 2);
  assert.equal(destinations.destinationsFor(account, "radio").length, 2);

  destinations.destinationsFor(account, "radio")[0].enabled = false;
  destinations.destinationsFor(account, "radio")[0].name = "Radio YouTube";

  assert.equal(destinations.destinationsFor(account, "gaming")[0].enabled, true);
  assert.equal(destinations.destinationsFor(account, "gaming")[0].name, "YouTube");
  assert.equal(destinations.destinationsFor(account, "radio")[0].name, "Radio YouTube");
});

test("profiles created after migration receive an empty independent destination bucket", () => {
  const account = accountFixture();
  destinations.ensure(account);
  account.overlays[0].config.profiles.push({ id:"vertical", name:"Vertical", mode:"pc" });
  assert.equal(destinations.ensure(account), true);
  assert.deepEqual(destinations.destinationsFor(account, "vertical"), []);
  assert.equal(destinations.destinationsFor(account, "gaming").length, 2);
});

test("removing a destination only removes it from the requested profile", () => {
  const account = accountFixture();
  destinations.ensure(account);
  assert.equal(destinations.removeDestination(account, "yt", "radio"), true);
  assert.equal(destinations.findDestination(account, "yt", "radio"), null);
  assert.ok(destinations.findDestination(account, "yt", "gaming"));
});
