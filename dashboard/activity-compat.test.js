"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const express = require("express");
const { createCompatManager, compatConfig, ffmpegArgs } = require("./activity-compat");
const { createDiscordActivityRouter } = require("./discord-activity");

function fakeSpawn(spawned) {
  return (bin, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    spawned.push({ bin, args, child });
    return child;
  };
}

test("config defaults and limits", () => {
  assert.deepEqual(compatConfig({}), { enabled:true, height:720, fps:30, bitrate:"2500k", max:2, idleMs:45000 });
  assert.equal(compatConfig({ DISCORD_ACTIVITY_COMPAT:"false" }).enabled, false);
  assert.equal(compatConfig({ DISCORD_ACTIVITY_COMPAT_HEIGHT:"99999", DISCORD_ACTIVITY_COMPAT_BITRATE:"rm -rf" }).height, 720);
  assert.equal(compatConfig({ DISCORD_ACTIVITY_COMPAT_BITRATE:"rm -rf" }).bitrate, "2500k");
});

test("FFmpeg reads the public program and publishes VP9 + Opus to activity-vp9/<login>", () => {
  const args = ffmpegArgs({ login:"neko", rtmpOrigin:"rtmp://127.0.0.1:1935", rtspOrigin:"rtsp://127.0.0.1:8554", config:compatConfig({}) });
  assert.equal(args[args.indexOf("-i") + 1], "rtmp://127.0.0.1:1935/public/neko");
  assert.equal(args[args.indexOf("-c:v") + 1], "libvpx-vp9");
  assert.equal(args[args.indexOf("-c:a") + 1], "libopus");
  assert.equal(args.at(-1), "rtsp://127.0.0.1:8554/activity-vp9/neko");
});

test("starts once per channel on demand, reports readiness, respects the limit, stops when idle", async () => {
  const spawned = [], logs = [];
  let clock = 1000, ready = false;
  const m = createCompatManager({
    env:{ DISCORD_ACTIVITY_COMPAT_MAX:"1", DISCORD_ACTIVITY_COMPAT_IDLE_MS:"10000" },
    spawnImpl:fakeSpawn(spawned), log:l => logs.push(l), now:() => clock,
    fetchImpl:async url => ({ ok:true, json:async () => ({ ready, url }) }),
  });
  try {
    const a = await m.ensure("Neko");
    assert.equal(a.ready, false); assert.equal(a.url, "/hls/activity-vp9/neko/index.m3u8");
    assert.equal(spawned.length, 1);
    ready = true; clock += 1000;
    assert.equal((await m.ensure("neko")).ready, true);
    assert.equal(spawned.length, 1, "one FFmpeg per channel");
    assert.equal((await m.ensure("other")).busy, true, "DISCORD_ACTIVITY_COMPAT_MAX respected");
    // idle: no viewer asked for it for longer than idleMs
    clock += 20000;
    m.stop("neko", "test idle");
    assert.equal(spawned[0].child.killed, true);
    assert.deepEqual(m.running(), []);
  } finally { m.shutdown(); }
});

test("disabled manager never spawns", async () => {
  const spawned = [];
  const m = createCompatManager({ env:{ DISCORD_ACTIVITY_COMPAT:"false" }, spawnImpl:fakeSpawn(spawned), log:() => {} });
  try { assert.deepEqual(await m.ensure("neko"), { enabled:false, ready:false }); assert.equal(spawned.length, 0); }
  finally { m.shutdown(); }
});

test("the /activity/api/compat endpoint only serves allowed channels", async () => {
  const calls = [];
  const app = express();
  app.use("/activity", createDiscordActivityRouter({
    getChannel:() => ({ login:"neko", displayName:"Neko", source:"console" }), env:{}, log:() => {},
    compat:{ config:{ enabled:true }, ensure:async login => { calls.push(login); return { enabled:true, ready:true, url:`/hls/activity-vp9/${login}/index.m3u8` }; } },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/activity/api/compat`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) });
  try {
    const ok = await post({ login:"neko" });
    assert.equal(ok.status, 200); assert.equal((await ok.json()).ready, true);
    assert.equal((await post({ login:"someoneelse" })).status, 404, "never transcodes a channel the Activity can't show");
    assert.equal((await post({ login:"../etc" })).status, 404);
    assert.deepEqual(calls, ["neko"]);
  } finally { server.close(); }
});
