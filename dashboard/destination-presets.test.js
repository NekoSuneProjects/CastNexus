"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadCatalog() {
  const context = { window:{} };
  vm.runInNewContext(fs.readFileSync(require.resolve("./public/destination-presets.js"), "utf8"), context);
  return context.window.CastNexusDestinationPresets;
}

test("fixed provider presets build complete secure destination URLs", () => {
  const catalog = loadCatalog();
  assert.equal(catalog.destinationUrl(catalog.byId("youtube"), "", "abcd-1234"), "rtmps://a.rtmps.youtube.com/live2/abcd-1234");
  assert.equal(catalog.destinationUrl(catalog.byId("twitch"), "", "/live_secret"), "rtmps://ingest.global-contribute.live-video.net/app/live_secret");
});

test("event-specific providers retain an editable server URL", () => {
  const catalog = loadCatalog();
  assert.equal(catalog.byId("facebook").autoUrl, undefined);
  assert.equal(catalog.byId("patreon").autoUrl, undefined);
  assert.equal(catalog.destinationUrl(catalog.byId("facebook"), "rtmps://example.test/live/", "secret"), "rtmps://example.test/live/secret");
  assert.ok(catalog.presets.length >= 15);
});

test("NekoLive multistream platforms are all available", () => {
  const catalog = loadCatalog();
  const fixed = {
    vpzone:"rtmps://rtmp-hd.vpzone.tv:443/live/KEY",
    hyperiontv:"rtmp://hyperiontv.net/stream/KEY",
    beamstream:"rtmps://live.beamstream.gg:443/live/KEY",
    velora:"rtmp://publish.velora.tv/live/KEY",
    uscreen:"rtmp://global-live.uscreen.app:5222/app/KEY",
    shareplay:"rtmp://stream.shareplay.tv/KEY",
    vrcdn:"rtmp://ingest.vrcdn.live/live/KEY",
  };
  for (const [id, url] of Object.entries(fixed)) assert.equal(catalog.destinationUrl(catalog.byId(id), "", "KEY"), url, id);
  const ids = new Set(catalog.presets.map(p => p.id));
  assert.equal(ids.size, catalog.presets.length, "preset ids are unique");
  for (const id of ["youtube", "twitch", "kick", "facebook", "instagram", "tiktok", "x", "rumble", "dailymotion", "mixcloud", "telegram", "patreon", "steam", "nimo", "picarto", "bilibili", "custom-rtmp", "custom-srt"]) assert.ok(ids.has(id), id);
});

test("suggested servers stay editable: the typed server URL wins", () => {
  const catalog = loadCatalog();
  for (const id of ["facebook", "x", "mixcloud", "steam", "nimo", "picarto", "bilibili"]) {
    const preset = catalog.byId(id);
    assert.match(preset.suggestUrl, /^rtmps?:\/\//, id);
    assert.equal(preset.autoUrl, undefined, `${id} must not lock the URL`);
  }
  assert.equal(catalog.destinationUrl(catalog.byId("picarto"), "rtmp://live.us-east1.picarto.tv/golive", "k"), "rtmp://live.us-east1.picarto.tv/golive/k");
});
