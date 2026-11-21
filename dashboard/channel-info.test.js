"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChannelInfoService } = require("./channel-info");

function setup({ responses = [] } = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url:String(url), method:options.method || "GET", headers:options.headers || {}, body:options.body ? JSON.parse(options.body) : null });
    const next = queue.shift() || { status:200, body:{} };
    return { ok:next.status >= 200 && next.status < 300, status:next.status, text:async () => (next.body === undefined ? "" : JSON.stringify(next.body)) };
  };
  const refreshes = [];
  const hostedOauth = {
    twitchRefresh:async token => { refreshes.push(["twitch", token]); return { access_token:"twitch-new", refresh_token:"twitch-r2", expires_in:3600 }; },
    kickRefresh:async token => { refreshes.push(["kick", token]); return { access_token:"kick-new", refresh_token:"kick-r2", expires_in:3600 }; },
  };
  const account = { twitchUserId:"42", twitchLogin:"me" };
  let saves = 0;
  const service = createChannelInfoService({ state:{}, saveState:() => { saves++; }, hostedOauth, fetchImpl });
  return { service, account, calls, refreshes, saves:() => saves };
}

const twitchResult = { user:{ id:"42", login:"me" }, clientId:"cid", accessToken:"twitch-a", refreshToken:"twitch-r", expiresIn:3600, scope:["channel:manage:broadcast"] };
const kickResult = { user:{ id:"7", login:"me_kick" }, accessToken:"kick-a", refreshToken:"kick-r", expiresIn:3600, scope:"user:read channel:read channel:write" };

test("Twitch connection must be the signed-in Twitch account", () => {
  const { service, account } = setup();
  assert.throws(() => service.storeConnection(account, "twitch", { ...twitchResult, user:{ id:"99", login:"other" } }), /signed in to CastNexus as "me"/);
  assert.equal(service.storeConnection(account, "twitch", twitchResult).connected, true);
  assert.equal(account.channelConnections.twitch.scope, "channel:manage:broadcast");
  assert.throws(() => service.storeConnection(account, "kick", { user:{ id:"7" } }), /did not return a token/);
});

test("Twitch title + game update uses Helix with the user token and Client-Id", async () => {
  const { service, account, calls } = setup({ responses:[{ status:204 }] });
  service.storeConnection(account, "twitch", twitchResult);
  const results = await service.update(account, { twitch:{ title:"  Hello\nworld ", categoryId:"509658" } });
  assert.deepEqual(results, { twitch:{ ok:true } });
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].url, "https://api.twitch.tv/helix/channels?broadcaster_id=42");
  assert.equal(calls[0].headers.Authorization, "Bearer twitch-a");
  assert.equal(calls[0].headers["Client-Id"], "cid");
  assert.deepEqual(calls[0].body, { title:"Hello world", game_id:"509658" });
});

test("a 401 refreshes the token through the broker once and retries", async () => {
  const { service, account, calls, refreshes } = setup({ responses:[{ status:401, body:{ message:"invalid" } }, { status:200, body:{ data:[{ stream_title:"Live!", category:{ id:15, name:"Just Chatting" } }] } }] });
  service.storeConnection(account, "kick", kickResult);
  const current = await service.current(account);
  assert.deepEqual(current.kick, { title:"Live!", category:{ id:"15", name:"Just Chatting" } });
  assert.deepEqual(refreshes, [["kick", "kick-r"]]);
  assert.equal(calls[1].headers.Authorization, "Bearer kick-new");
  assert.equal(account.channelConnections.kick.refreshToken, "kick-r2");
});

test("Kick update sends stream_title + numeric category_id; category search falls back to v1", async () => {
  const { service, account, calls } = setup({ responses:[{ status:204 }, { status:404, body:{ message:"nope" } }, { status:200, body:{ data:[{ id:3, name:"Minecraft", thumbnail:"x" }] } }] });
  service.storeConnection(account, "kick", kickResult);
  assert.deepEqual(await service.update(account, { kick:{ title:"New", categoryId:"3" } }), { kick:{ ok:true } });
  assert.deepEqual(calls[0].body, { stream_title:"New", category_id:3 });
  const found = await service.searchCategories(account, "kick", "mine");
  assert.deepEqual(found, [{ id:"3", name:"Minecraft", image:"x" }]);
  assert.match(calls[1].url, /\/v2\/categories/);
  assert.match(calls[2].url, /\/v1\/categories\?q=mine/);
});

test("each platform succeeds or fails on its own; bad input is refused", async () => {
  const { service, account } = setup({ responses:[{ status:500, body:{ message:"boom" } }] });
  service.storeConnection(account, "twitch", twitchResult);
  const results = await service.update(account, { twitch:{ title:"ok" }, kick:{ title:"x" }, youtube:{ title:"y" } });
  assert.equal(results.twitch.ok, false);
  assert.match(results.twitch.error, /boom/);
  assert.equal(results.kick.code, "NOT_CONNECTED");
  assert.equal(results.youtube.ok, false);
  const bad = await service.update(account, { twitch:{ title:"   " } });
  assert.match(bad.twitch.error, /cannot be empty/);
  const badCat = await service.update(account, { twitch:{ categoryId:"1; drop" } });
  assert.match(badCat.twitch.error, /invalid category/);
});

test("titles are trimmed to the platform limit", async () => {
  const { service, account, calls } = setup({ responses:[{ status:204 }] });
  service.storeConnection(account, "twitch", twitchResult);
  const results = await service.update(account, { twitch:{ title:"x".repeat(200) } });
  assert.equal(results.twitch.truncated, true);
  assert.equal(calls[0].body.title.length, 140);
});
