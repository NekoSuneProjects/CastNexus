"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { base64url, sha256, safeEqual, validChallenge, brokerMountPath, stripBrokerMount } = require("./server");

test("PKCE S256 challenge uses URL-safe base64", () => {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(sha256(verifier));
  assert.equal(validChallenge(challenge), true);
  assert.equal(challenge.includes("="), false);
  assert.equal(safeEqual(challenge, base64url(sha256(verifier))), true);
  assert.equal(safeEqual(challenge, base64url(sha256(verifier + "x"))), false);
});

test("malformed PKCE challenges are rejected", () => {
  for (const value of ["", "short", "a".repeat(42), "a".repeat(44), "!".repeat(43)]) assert.equal(validChallenge(value), false);
});

test("broker accepts proxies that preserve or strip its public mount path", () => {
  assert.equal(brokerMountPath("https://castnexus.nekosunevr.co.uk/oauth"), "/oauth");
  assert.equal(stripBrokerMount("/oauth/health", "/oauth"), "/health");
  assert.equal(stripBrokerMount("/oauth/v1/transactions?test=1", "/oauth"), "/v1/transactions?test=1");
  assert.equal(stripBrokerMount("/health", "/oauth"), "/health");
  assert.equal(stripBrokerMount("/oauth-other", "/oauth"), "/oauth-other");
});
