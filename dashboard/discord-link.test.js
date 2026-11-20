"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { discordOauthConfig, createDiscordApi, linkDiscord, liveLinkedChannels, publicDiscordLink } = require("./discord-link");
const { createDiscordActivityRouter, publicChannel } = require("./discord-activity");

test("oauth config needs a numeric client id and a secret", () => {
  assert.equal(discordOauthConfig({ DISCORD_CLIENT_ID:"123456789012345678" }).enabled, false);
  assert.equal(discordOauthConfig({ DISCORD_CLIENT_ID:"123456789012345678", DISCORD_CLIENT_SECRET:"s".repeat(32) }).enabled, true);
  assert.equal(discordOauthConfig({ DISCORD_CLIENT_ID:"abc", DISCORD_CLIENT_SECRET:"s".repeat(32) }).enabled, false);
});

test("one Discord user links to exactly one CastNexus account", () => {
  const a = { twitchLogin:"a" }, b = { twitchLogin:"b" };
  const state = { accounts:{ 1:a, 2:b } };
  linkDiscord(state, a, { id:"900000000000000001", username:"neko" });
  linkDiscord(state, b, { id:"900000000000000001", username:"neko" });
  assert.equal(a.discord, undefined, "moved off the old account");
  assert.equal(b.discord.id, "900000000000000001");
  assert.equal(publicDiscordLink(b).visible, true, "visible by default");
});

test("only linked, opted-in, unblocked and live accounts are detected", () => {
  const mk = (login, id, extra = {}) => ({ twitchLogin:login, twitchUserId:login, discord:{ id }, ...extra });
  const state = { accounts:{
    live:mk("live", "100000000000000001"),
    hidden:mk("hidden", "100000000000000002", { discordActivityVisible:false }),
    blocked:mk("blocked", "100000000000000003", { blocked:true }),
    offline:mk("offline", "100000000000000004"),
    elsewhere:mk("elsewhere", "100000000000000005"),
  } };
  const rows = liveLinkedChannels(state, ["100000000000000001", "100000000000000002", "100000000000000003", "100000000000000004"], {
    isLive:a => a.twitchLogin !== "offline",
    row:a => ({ login:a.twitchLogin, source:"console" }),
  });
  assert.deepEqual(rows.map(r => r.login), ["live"]);
});

function fakeDiscordFetch(calls) {
  return async (url, opts = {}) => {
    calls.push(String(url));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ "Content-Type":"application/json" } });
    if (String(url).endsWith("/oauth2/token")) return String(opts.body).includes("code=good") ? json({ access_token:"viewer-token-0123456789abcdef", expires_in:600, scope:"identify guilds" }) : json({ error:"invalid_grant" }, 400);
    if (String(url).endsWith("/users/@me")) return opts.headers?.Authorization === "Bearer viewer-token-0123456789abcdef" ? json({ id:"700000000000000007", username:"viewer" }) : json({ message:"401" }, 401);
    if (String(url).startsWith("https://static-cdn.jtvnw.net/")) return new Response(Buffer.from("PNG"), { status:200, headers:{ "Content-Type":"image/png" } });
    throw new Error("unexpected " + url);
  };
}

test("the Activity exchanges codes, checks the viewer and returns only live linked streamers", async () => {
  const calls = [];
  const fetchImpl = fakeDiscordFetch(calls);
  const config = discordOauthConfig({ DISCORD_CLIENT_ID:"123456789012345678", DISCORD_CLIENT_SECRET:"s".repeat(32) });
  const discordApi = createDiscordApi({ config, fetchImpl });
  const app = express();
  app.use("/activity", createDiscordActivityRouter({
    getChannel:() => ({ login:"owner", displayName:"Owner", source:null }),
    getMode:() => "auto",
    discordApi,
    liveLinked:ids => ids.includes("500000000000000005") ? [{ login:"ps5player", displayName:"PS5 Player", source:"console", profileImageUrl:"https://static-cdn.jtvnw.net/a.png", discordId:"500000000000000005" }] : [],
    streamAllowed:login => login === "owner" || login === "ps5player",
    avatarUrlFor:login => login === "ps5player" ? "https://static-cdn.jtvnw.net/a.png" : login === "evil" ? "https://evil.example/x.png" : null,
    fetchImpl,
    env:{ DISCORD_CLIENT_ID:"123456789012345678" },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/activity`;
  const post = (p, body, headers = {}) => fetch(base + p, { method:"POST", headers:{ "Content-Type":"application/json", ...headers }, body:JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(base + "/api/config")).json()).autoDetect, true);
    assert.equal((await post("/api/token", { code:"bad" })).status, 400);
    const token = await (await post("/api/token", { code:"good" })).json();
    assert.equal(token.access_token, "viewer-token-0123456789abcdef");

    assert.equal((await post("/api/voice-live", { userIds:["500000000000000005"] })).status, 401, "needs the viewer's token");
    const auth = { Authorization:`Bearer ${token.access_token}` };
    const live = await (await post("/api/voice-live", { userIds:["500000000000000005", "not-an-id"] }, auth)).json();
    assert.deepEqual(live.channels, [{ login:"ps5player", displayName:"PS5 Player", profileImageUrl:"api/avatar/ps5player", live:true, source:"console", discordId:"500000000000000005" }]);
    const before = calls.filter(c => c.endsWith("/users/@me")).length;
    await post("/api/voice-live", { userIds:[] }, auth);
    assert.equal(calls.filter(c => c.endsWith("/users/@me")).length, before, "viewer identity is cached");

    const avatar = await fetch(base + "/api/avatar/ps5player");
    assert.equal(avatar.status, 200); assert.equal(avatar.headers.get("content-type"), "image/png");
    assert.equal((await fetch(base + "/api/avatar/evil")).status, 404, "only Twitch's CDN is proxied");
    assert.equal((await fetch(base + "/api/avatar/nobody")).status, 404);
  } finally { server.close(); }
});

test("auto-detect stays off without DISCORD_CLIENT_SECRET or in fixed mode", async () => {
  const app = express();
  app.use("/a", createDiscordActivityRouter({ getChannel:() => null, env:{} }));
  app.use("/b", createDiscordActivityRouter({ getChannel:() => null, getMode:() => "fixed", discordApi:{}, env:{} }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ["/a", "/b"]) {
      assert.equal((await (await fetch(`${base}${p}/api/config`)).json()).autoDetect, false);
      assert.equal((await fetch(`${base}${p}/api/token`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" })).status, 404);
    }
  } finally { server.close(); }
});

test("public channel rows point avatars at the local proxy", () => {
  assert.equal(publicChannel({ login:"Neko", profileImageUrl:"https://static-cdn.jtvnw.net/x.png" }).profileImageUrl, "api/avatar/neko");
});
