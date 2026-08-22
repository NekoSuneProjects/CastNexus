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
  assert.equal(catalog.destinationUrl(catalog.byId("facebook"), "rtmps://example.test/live/", "secret"), "rtmps://example.test/live/secret");
  assert.ok(catalog.presets.length >= 15);
});
