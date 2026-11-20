"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { activityConfig, selectedChannelLogin, streamPathAllowed, publicChannel, createDiscordActivityRouter } = require("./discord-activity");

test("config validates the client id and reads the channel lock", () => {
  assert.equal(activityConfig({ DISCORD_CLIENT_ID:"123456789012345678" }).clientId, "123456789012345678");
  const bad = activityConfig({ DISCORD_CLIENT_ID:"not-a-number" });
  assert.equal(bad.clientId, "");
  assert.equal(bad.clientIdInvalid, true);
  assert.equal(activityConfig({ DISCORD_ACTIVITY_CHANNEL:" NekoSuneVR " }).lockedChannel, "nekosunevr");
  assert.equal(activityConfig({}).lockedChannel, "");
});

test("channel choice: env lock > owner's saved pick > owner's own channel", () => {
  const logins = ["NekoSuneVR", "friend"];
  assert.equal(selectedChannelLogin({ ownerLogin:"NekoSuneVR", logins }), "nekosunevr");
  assert.equal(selectedChannelLogin({ ownerLogin:"nekosunevr", savedChannel:"friend", logins }), "friend");
  assert.equal(selectedChannelLogin({ ownerLogin:"nekosunevr", savedChannel:"gone", logins }), "nekosunevr", "a deleted account falls back to the owner");
  assert.equal(selectedChannelLogin({ ownerLogin:"nekosunevr", savedChannel:"friend", lockedChannel:"Other", logins }), "other");
  assert.equal(selectedChannelLogin({ logins }), null);
});

test("stream proxy only allows the selected channel's public program", () => {
  assert.equal(streamPathAllowed("/public/nekosunevr/index.m3u8", "nekosunevr"), true);
  assert.equal(streamPathAllowed("/public/NekoSuneVR/whep", "nekosunevr"), true);
  assert.equal(streamPathAllowed("/public/friend/index.m3u8", "nekosunevr"), false, "other people's channels are never served");
  assert.equal(streamPathAllowed("/app/live_streamkey", "nekosunevr"), false, "ingest paths are never served");
  assert.equal(streamPathAllowed("/public/%E0%A4%A/x", "nekosunevr"), false);
  assert.equal(streamPathAllowed("/public/nekosunevr/index.m3u8", null), false);
});

test("public channel info drops non-https avatars", () => {
  assert.deepEqual(publicChannel({ login:"Neko", displayName:"Neko", profileImageUrl:"http://x/a.png", source:"console" }), { login:"neko", displayName:"Neko", profileImageUrl:null, live:true, source:"console" });
  assert.equal(publicChannel(null), null);
});

async function withServer(channelRef, fn) {
  const upstream = http.createServer((req, res) => { res.end(`upstream:${req.method}:${req.url}`); });
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const app = express();
  const router = createDiscordActivityRouter({ getChannel:() => channelRef.current, env:{ DISCORD_CLIENT_ID:"123456789012345678" }, hlsTarget:target, webrtcTarget:target });
  app.use("/activity", router);
  app.get(["/activity-app.js", "/activity-app.css"], router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); upstream.close(); }
}

test("router serves the page, SDK and only the selected channel's stream", async () => {
  const channelRef = { current:{ login:"nekosunevr", displayName:"NekoSuneVR", source:"console" } };
  await withServer(channelRef, async base => {
    for (const p of ["/activity", "/activity/"]) {
      const page = await fetch(base + p);
      assert.equal(page.status, 200, p);
      assert.equal(page.headers.get("x-frame-options"), null, "Discord must be able to frame the page");
      assert.match(await page.text(), /activity-app\.js/);
    }
    assert.equal((await fetch(base + "/activity-app.js")).status, 200, "root alias for /activity without slash");
    const cfg = await (await fetch(base + "/activity/api/config")).json();
    assert.equal(cfg.clientId, "123456789012345678");
    assert.equal(cfg.sdk, true);
    const sdk = await fetch(base + "/activity/sdk/index.mjs");
    assert.equal(sdk.status, 200);
    assert.match(sdk.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(base + "/activity/hls.min.js")).status, 200);

    const { channel } = await (await fetch(base + "/activity/api/channel")).json();
    assert.deepEqual(channel, { login:"nekosunevr", displayName:"NekoSuneVR", profileImageUrl:null, live:true, source:"console" });

    assert.equal(await (await fetch(base + "/activity/hls/public/nekosunevr/index.m3u8")).text(), "upstream:GET:/public/nekosunevr/index.m3u8");
    assert.equal(await (await fetch(base + "/activity/webrtc/public/nekosunevr/whep", { method:"POST", body:"v=0" })).text(), "upstream:POST:/public/nekosunevr/whep");
    assert.equal((await fetch(base + "/activity/hls/public/friend/index.m3u8")).status, 404);
    assert.equal((await fetch(base + "/activity/hls/app/secret-key/index.m3u8")).status, 404);

    // The owner switches the channel: the old one is no longer reachable.
    channelRef.current = { login:"friend", displayName:"Friend", source:null };
    assert.equal((await fetch(base + "/activity/hls/public/nekosunevr/index.m3u8")).status, 404);
    assert.equal((await (await fetch(base + "/activity/api/channel")).json()).channel.live, false);

    channelRef.current = null;
    assert.equal((await (await fetch(base + "/activity/api/channel")).json()).channel, null);
  });
});

test("classic TS HLS fallback is guarded like the other stream routes; viewer logs are sanitised", async () => {
  const upstream = http.createServer((req, res) => { res.end(`ts:${req.url}`); });
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  const logs = [];
  const app = express();
  app.use("/activity", createDiscordActivityRouter({
    getChannel:() => ({ login:"neko", displayName:"Neko", source:"console" }),
    env:{}, tsHlsTarget:`http://127.0.0.1:${upstream.address().port}`, log:line => logs.push(line),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/activity`;
  try {
    assert.equal(await (await fetch(`${base}/tshls/public/neko/index.m3u8`)).text(), "ts:/public/neko/index.m3u8");
    assert.equal((await fetch(`${base}/tshls/public/other/index.m3u8`)).status, 404);
    const r = await fetch(`${base}/api/log`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ message:"ll failed\ninjected line \u00e9", ua:"UA" }) });
    assert.equal(r.status, 204);
    assert.deepEqual(logs, ["[discord-activity] viewer: ll failed injected line ? | UA"]);
  } finally { server.close(); upstream.close(); }
});
