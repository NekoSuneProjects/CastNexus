"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pickOwner, isOwner } = require("./owner");

const accounts = {
  2:{ twitchUserId:"2", twitchLogin:"Friend", createdAt:"2026-03-01T00:00:00Z" },
  1:{ twitchUserId:"1", twitchLogin:"NekoSuneVR", createdAt:"2026-01-01T00:00:00Z" },
  3:{ twitchUserId:"3", twitchLogin:"late", createdAt:"2026-05-01T00:00:00Z" },
};

test("the first account to sign in is the owner by default", () => {
  assert.equal(pickOwner(accounts, {}).twitchUserId, "1");
});

test("CASTNEXUS_OWNER_LOGIN wins, and names nobody until that login signs in", () => {
  assert.equal(pickOwner(accounts, { CASTNEXUS_OWNER_LOGIN:"friend" }).twitchUserId, "2");
  assert.equal(pickOwner(accounts, { CASTNEXUS_OWNER_LOGIN:"someone-else" }), null);
});

test("otherwise the first signed-in ALLOWED_TWITCH_LOGINS entry is the owner", () => {
  assert.equal(pickOwner(accounts, { ALLOWED_TWITCH_LOGINS:"missing, late,nekosunevr" }).twitchUserId, "3");
});

test("isOwner compares by Twitch user id; no accounts means no owner", () => {
  assert.equal(isOwner(accounts[1], accounts, {}), true);
  assert.equal(isOwner(accounts[2], accounts, {}), false);
  assert.equal(pickOwner({}, {}), null);
});
