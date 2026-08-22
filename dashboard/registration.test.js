"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registrationDisabled, allowedLogins, loginDecision, refusalMessage, locksOutEveryone } = require("./registration");

test("registration is open unless the env explicitly closes it", () => {
  assert.equal(registrationDisabled({}), false);
  assert.equal(registrationDisabled({ DISABLE_REGISTRATION:"" }), false);
  assert.equal(registrationDisabled({ DISABLE_REGISTRATION:"false" }), false);
  for (const value of ["true", "TRUE", "1", "yes", "on", " true "]) {
    assert.equal(registrationDisabled({ DISABLE_REGISTRATION:value }), true, value);
  }
});

test("a closed instance still signs in the accounts it already has", () => {
  const env = { DISABLE_REGISTRATION:"true" };
  assert.deepEqual(loginDecision({ accountExists:true, login:"nekosunevr", env }), { allowed:true, reason:"existing-account" });
});

test("a closed instance refuses to register anybody new", () => {
  const env = { DISABLE_REGISTRATION:"true" };
  const decision = loginDecision({ accountExists:false, login:"someone-else", env });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "registration-disabled");
  assert.match(refusalMessage(decision.reason), /not accepting new accounts/);
});

test("an open instance keeps registering new accounts", () => {
  assert.deepEqual(loginDecision({ accountExists:false, login:"newcomer", env:{} }), { allowed:true, reason:"registration-open" });
});

test("the allowlist is checked before anything else, existing account or not", () => {
  const env = { ALLOWED_TWITCH_LOGINS:"NekoSuneVR, cohost" };
  assert.deepEqual(allowedLogins(env), ["nekosunevr", "cohost"]);
  // Case-insensitive: Twitch logins are lowercase but operators type anything.
  assert.equal(loginDecision({ accountExists:false, login:"NekoSuneVR", env }).allowed, true);
  assert.equal(loginDecision({ accountExists:false, login:"cohost", env }).allowed, true);
  // An account that already exists but has since been removed from the list is
  // locked out too - that is the point of taking someone off the list.
  const removed = loginDecision({ accountExists:true, login:"ex-cohost", env });
  assert.equal(removed.allowed, false);
  assert.equal(removed.reason, "not-on-allowlist");
});

test("an allowlist names the owner, so it can bootstrap a fresh install", () => {
  const env = { DISABLE_REGISTRATION:"true", ALLOWED_TWITCH_LOGINS:"nekosunevr" };
  assert.equal(loginDecision({ accountExists:false, login:"nekosunevr", env }).allowed, true);
  assert.equal(loginDecision({ accountExists:false, login:"stranger", env }).allowed, false);
});

test("a config that can never admit anyone is detectable at startup", () => {
  assert.equal(locksOutEveryone({ accountCount:0, env:{ DISABLE_REGISTRATION:"true" } }), true);
  assert.equal(locksOutEveryone({ accountCount:1, env:{ DISABLE_REGISTRATION:"true" } }), false);
  assert.equal(locksOutEveryone({ accountCount:0, env:{ DISABLE_REGISTRATION:"true", ALLOWED_TWITCH_LOGINS:"owner" } }), false);
  assert.equal(locksOutEveryone({ accountCount:0, env:{} }), false);
});
