"use strict";

// VOD playlists, shuffle, optional local downloads and the Twitch VOD
// re-encode that fixed black WebRTC previews.

// A stand-in "ffmpeg" that exits straight away (node rejects the FFmpeg
// flags), so playlist runs can be exercised without real media.
process.env.FFMPEG_BIN = process.execPath;
process.env.CASTNEXUS_HARDWARE_PROBE = "false";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProfileVodService, ffmpegArgsFor, copiesVideo } = require("./profile-vod");
const { PROFILE_STORE_SYSTEM } = require("./profile-rtmp");

const RTMP_KEY = "a".repeat(36);

function setup({ allowCustomDownloadDir = false, catalog = [] } = {}) {
  const vodDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-vodpl-"));
  const account = {
    twitchUserId:"42",
    overlays:[{ id:"store", config:{ system:PROFILE_STORE_SYSTEM, activeProfileId:"vod1", profiles:[{ id:"vod1", name:"VOD Reruns", mode:"vod", rtmpKey:RTMP_KEY }] } }],
    vodProfiles:{ vod1:{ items:[
      { id:"a", kind:"upload", title:"A", filename:"a.mp4" },
      { id:"b", kind:"upload", title:"B", filename:"b.mp4" },
      { id:"c", kind:"youtube", title:"C", url:"https://www.youtube.com/watch?v=c" },
    ] } },
    twitchVodCatalog:{ updatedAt:new Date().toISOString(), items:catalog },
  };
  for (const f of ["a.mp4", "b.mp4"]) {
    fs.mkdirSync(path.join(vodDir, "42", "vod1"), { recursive:true });
    fs.writeFileSync(path.join(vodDir, "42", "vod1", f), "video");
  }
  const state = { accounts:{ 42:account } };
  const service = createProfileVodService({ state, saveState:() => {}, vodDir, maxBytes:1e9, probeDurationSeconds:async () => 1, allowCustomDownloadDir, twitchApi:{ getVideos:async () => catalog } });
  return { service, account, vodDir };
}

async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
}

test("Twitch VODs are re-encoded (no B-frames for WebRTC); Twitch live is still copied", () => {
  assert.equal(copiesVideo("twitch-live"), true);
  assert.equal(copiesVideo("twitch-vod"), false);
  const vod = ffmpegArgsFor({ kind:"twitch-vod", inputs:["https://example.test/index-dvr.m3u8"] }, "rtmp://127.0.0.1:1935/relay/p/k");
  assert.notEqual(vod[vod.indexOf("-c:v") + 1], "copy");
  assert.ok(vod.includes("-re"), "VODs are paced");
  assert.ok(vod.includes("+genpts+discardcorrupt"), "HLS input options stay on remote Twitch input");
  assert.ok(vod.includes("aresample=async=1:first_pts=0"), "Twitch audio is rebuilt as continuous AAC");
  const local = ffmpegArgsFor({ kind:"file", inputs:["/tmp/x.mp4"] }, "rtmp://127.0.0.1:1935/relay/p/k");
  assert.equal(local.includes("+genpts+discardcorrupt"), false, "a downloaded local file needs no HLS input options");
  assert.notEqual(local[local.indexOf("-c:v") + 1], "copy");
});

test("playlist keeps order, drops unknown/duplicate ids and survives item deletion", () => {
  const { service, account } = setup();
  assert.deepEqual(service.setPlaylist(account, "vod1", ["b", "nope", "a", "b"]), ["b", "a"]);
  account.vodProfiles.vod1.items = account.vodProfiles.vod1.items.filter(i => i.id !== "b");
  assert.deepEqual(service.playlistFor(service.bucketFor(account, "vod1")), ["a"]);
});

test("a Twitch cloud VOD is copied into the library once when added to the playlist", async () => {
  const catalog = [{ id:"999", title:"Big stream", url:"https://www.twitch.tv/videos/999", durationS:3600, userName:"me" }];
  const { service, account } = setup({ catalog });
  const first = await service.addToPlaylist(account, "vod1", { twitchVideoId:"999" });
  const second = await service.addToPlaylist(account, "vod1", { twitchVideoId:"999" });
  assert.equal(first.item.id, second.item.id);
  assert.equal(account.vodProfiles.vod1.items.filter(i => i.twitchVideoId === "999").length, 1);
  assert.equal(first.item.kind, "twitch-vod");
  await assert.rejects(service.addToPlaylist(account, "vod1", { twitchVideoId:"404" }), /not found/);
});

test("shuffled playlist play starts a queue over the whole library and stops when every item fails", async () => {
  const { service, account } = setup();
  // Only the two uploads are playable without a network resolver.
  account.vodProfiles.vod1.items = account.vodProfiles.vod1.items.filter(i => i.kind === "upload");
  const status = await service.playPlaylist(account, "vod1", { shuffle:true, loop:true });
  assert.equal(status.shuffle, true);
  assert.deepEqual([...status.queue.ids].sort(), ["a", "b"]);
  // The stand-in ffmpeg fails every item: the loop must give up, not spin.
  assert.ok(await waitFor(() => service.publicStatus("42").state === "error"), `state ${service.publicStatus("42").state}`);
  assert.match(service.publicStatus("42").error, /every playlist item failed/);
  await service.stop("42");
});

test("download settings: custom folders only where allowed, must be absolute", () => {
  const docker = setup();
  assert.throws(() => docker.service.updateSettings(docker.account, { downloadDir:"/tmp/x" }), /only available in the desktop app/);
  assert.equal(docker.service.updateSettings(docker.account, { preferLocal:false }).preferLocal, false);

  const desktop = setup({ allowCustomDownloadDir:true });
  assert.throws(() => desktop.service.updateSettings(desktop.account, { downloadDir:"relative/dir" }), /full folder path/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-vod-dl-"));
  assert.equal(desktop.service.updateSettings(desktop.account, { downloadDir:dir }).downloadDir, dir);
});

test("uploads cannot be 'downloaded'; removing a download deletes the local file", () => {
  const { service, account, vodDir } = setup();
  assert.throws(() => service.startDownload(account, "vod1", "a"), /uploads are already local/);
  const file = path.join(vodDir, "c.mp4");
  fs.writeFileSync(file, "x");
  account.vodProfiles.vod1.items.find(i => i.id === "c").download = { state:"done", file, dir:vodDir };
  service.removeDownload(account, "vod1", "c");
  assert.equal(account.vodProfiles.vod1.items.find(i => i.id === "c").download, undefined);
  return waitFor(() => !fs.existsSync(file), 2000).then(gone => assert.ok(gone));
});
