"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { activityConfig, visibleChannels, allowedStreamLogin, createDiscordActivityRouter } = require("./discord-activity");

const rows = [
  { login:"nekosunevr", displayName:"NekoSuneVR", source:"console", profileImageUrl:"https://example.com/a.png" },
  { login:"friend", displayName:"Friend", source:null, profileImageUrl:"http://insecure/a.png" },
  { login:"other", displayName:"Other", source:"pc" },
];

test("config validates the client id and parses the channel allow-list", () => {
  assert.equal(activityConfig({ DISCORD_CLIENT_ID:"123456789012345678" }).clientId, "123456789012345678");
  const bad = activityConfig({ DISCORD_CLIENT_ID:"not-a-number" });
  assert.equal(bad.clientId, "");
  assert.equal(bad.clientIdInvalid, true);
  assert.equal(activityConfig({ DISCORD_ACTIVITY_CHANNELS:"*" }).allowed, null);
  assert.deepEqual([...activityConfig({ DISCORD_ACTIVITY_CHANNELS:"NekoSuneVR, friend" }).allowed], ["nekosunevr", "friend"]);
});

test("without an allow-list only live channels are listed, live first", () => {
  const list = visibleChannels(rows, activityConfig({}));
  assert.deepEqual(list.map(c => c.login), ["nekosunevr", "other"]);
  assert.equal(list[0].source, "console");
});

test("an allow-list shows its channels (offline too) and hides everyone else", () => {
  const list = visibleChannels(rows, activityConfig({ DISCORD_ACTIVITY_CHANNELS:"friend,nekosunevr" }));
  assert.deepEqual(list.map(c => [c.login, c.live]), [["nekosunevr", true], ["friend", false]]);
  assert.equal(list[1].profileImageUrl, null, "non-https avatars are dropped");
});

test("stream proxy only allows public/<login> of permitted channels", () => {
  const open = activityConfig({});
  assert.equal(allowedStreamLogin("/public/nekosunevr/index.m3u8", rows, open), "nekosunevr");
  assert.equal(allowedStreamLogin("/public/unknown/index.m3u8", rows, open), null);
  assert.equal(allowedStreamLogin("/app/streamkey", rows, open), null);
  assert.equal(allowedStreamLogin("/public/%E0%A4%A/x", rows, open), null);
  const limited = activityConfig({ DISCORD_ACTIVITY_CHANNELS:"nekosunevr" });
  assert.equal(allowedStreamLogin("/public/other/whep", rows, limited), null);
});

async function withServer(fn) {
  const upstream = http.createServer((req, res) => { res.end(`upstream:${req.method}:${req.url}`); });
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const app = express();
  const router = createDiscordActivityRouter({ listChannels:() => rows, env:{ DISCORD_CLIENT_ID:"123456789012345678" }, hlsTarget:target, webrtcTarget:target });
  app.use("/activity", router);
  app.get(["/activity-app.js", "/activity-app.css"], router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); upstream.close(); }
}

test("router serves the page, config, SDK and guarded stream proxies", async () => {
  await withServer(async base => {
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
    const channels = await (await fetch(base + "/activity/api/channels")).json();
    assert.deepEqual(channels.channels.map(c => c.login), ["nekosunevr", "other"]);

    const hls = await fetch(base + "/activity/hls/public/nekosunevr/index.m3u8");
    assert.equal(await hls.text(), "upstream:GET:/public/nekosunevr/index.m3u8");
    const whep = await fetch(base + "/activity/webrtc/public/other/whep", { method:"POST", body:"v=0" });
    assert.equal(await whep.text(), "upstream:POST:/public/other/whep");
    assert.equal((await fetch(base + "/activity/hls/app/secret-key/index.m3u8")).status, 404);
    assert.equal((await fetch(base + "/activity/hls/public/nobody/index.m3u8")).status, 404);
  });
});
