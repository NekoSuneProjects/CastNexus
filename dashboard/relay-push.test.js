"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RELAY_DESTINATION_ID, relayDestinationFor, cachedRelayDestination, tokenCache } = require("./relay-push");

function fakeAccount(overrides = {}) {
  return { relayNodeId:"node-abc", relayPushEnabled:true, relayPushMode:"rtmp", ...overrides };
}

test("relayDestinationFor returns null when push is disabled", async () => {
  const dest = await relayDestinationFor(fakeAccount({ relayPushEnabled:false }));
  assert.equal(dest, null);
});

test("relayDestinationFor registers and builds an rtmp destination object, then caches it", async () => {
  tokenCache.clear();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok:true,
    json:async () => ({
      nodeId:"node-abc",
      pushToken:"tok123",
      expiresIn:3600,
      rtmpUrl:"rtmp://relay.example.com:1936/push/node-abc",
      whipUrl:"https://relay.example.com/whip/node-abc",
      watchUrl:"https://relay.example.com/relay/node-abc",
    }),
  });
  try {
    const account = fakeAccount();
    const dest = await relayDestinationFor(account, { baseUrl:"https://relay.example.com" });
    assert.equal(dest.id, RELAY_DESTINATION_ID);
    assert.equal(dest.transport, "rtmp");
    assert.ok(dest.url.startsWith("rtmp://relay.example.com:1936/push/node-abc?token="));

    const cached = cachedRelayDestination(account);
    assert.equal(cached.transport, "rtmp");
    assert.equal(cached.watchUrl, "https://relay.example.com/relay/node-abc");
  } finally {
    global.fetch = originalFetch;
  }
});

test("relayDestinationFor builds a whip destination object when mode is whip", async () => {
  tokenCache.clear();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok:true,
    json:async () => ({
      nodeId:"node-xyz",
      pushToken:"tok456",
      expiresIn:3600,
      rtmpUrl:"rtmp://relay.example.com:1936/push/node-xyz",
      whipUrl:"https://relay.example.com/whip/node-xyz",
      watchUrl:"https://relay.example.com/relay/node-xyz",
    }),
  });
  try {
    const account = fakeAccount({ relayNodeId:"node-xyz", relayPushMode:"whip" });
    const dest = await relayDestinationFor(account, { baseUrl:"https://relay.example.com" });
    assert.equal(dest.transport, "whip");
    assert.ok(dest.url.startsWith("https://relay.example.com/whip/node-xyz?token="));
  } finally {
    global.fetch = originalFetch;
  }
});

test("cachedRelayDestination returns null when nothing has been registered yet", () => {
  tokenCache.clear();
  assert.equal(cachedRelayDestination(fakeAccount({ relayNodeId:"never-seen" })), null);
});
