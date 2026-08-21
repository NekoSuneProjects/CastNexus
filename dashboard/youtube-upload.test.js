"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {parseAllowlist,quotaAllowed,encryptSecret,decryptSecret,dailyKey}=require("./youtube-upload");

test("YouTube upload allowlist accepts Twitch id or login",()=>{
  const list=parseAllowlist("42, neko_sune");
  assert.equal(quotaAllowed({twitchUserId:"42",twitchLogin:"other"},list),true);
  assert.equal(quotaAllowed({twitchUserId:"99",twitchLogin:"NEKO_SUNE"},list),true);
  assert.equal(quotaAllowed({twitchUserId:"99",twitchLogin:"nope"},list),false);
  assert.equal(quotaAllowed({twitchUserId:"99"},parseAllowlist("*")),true);
});

test("refresh token encryption round-trips without storing plaintext",()=>{
  const blob=encryptSecret("refresh-secret","session-key");
  assert.notEqual(blob.data,"refresh-secret");
  assert.equal(decryptSecret(blob,"session-key"),"refresh-secret");
});

test("daily quota key is UTC YYYY-MM-DD",()=>{
  assert.equal(dailyKey(new Date("2026-08-21T23:59:00Z")),"2026-08-21");
});
