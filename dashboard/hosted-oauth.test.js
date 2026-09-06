"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHostedOauth, createPkce, base64url } = require("./hosted-oauth");
const crypto = require("node:crypto");

test("hosted OAuth creates a valid S256 PKCE pair", () => {
  const pair = createPkce();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pair.challenge, base64url(crypto.createHash("sha256").update(pair.verifier).digest()));
});

test("hosted OAuth refuses non-HTTPS or missing brokers", () => {
  assert.throws(() => createHostedOauth({ brokerUrl:"http://example.test/oauth" }));
  assert.throws(() => createHostedOauth({ brokerUrl:"" }));
  assert.doesNotThrow(() => createHostedOauth({ brokerUrl:"https://restreamer.example/oauth" }));
});
