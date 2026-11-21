"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseYouTubeUrl, youtubeEmbedUrl, sanitiseLayer, LAYER_TYPES, AUDIO_TYPES } = require("./scene-model");
const { layerContent } = require("./scene-render");

test("YouTube links of every shape parse; lookalike hosts do not", () => {
  const id = "dQw4w9WgXcQ";
  for (const url of [`https://www.youtube.com/watch?v=${id}`, `https://youtu.be/${id}`, `https://m.youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}`, `https://www.youtube.com/embed/${id}`]) {
    assert.equal(parseYouTubeUrl(url)?.videoId, id, url);
  }
  assert.equal(parseYouTubeUrl(`https://youtu.be/${id}?t=1m30s`).start, 90);
  assert.equal(parseYouTubeUrl("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG").playlistId, "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG");
  for (const bad of [`https://www.youtube.com.evil.example/watch?v=${id}`, `https://evil.example/watch?v=${id}`, "javascript:alert(1)", "https://www.youtube.com/watch?v=short"]) assert.equal(parseYouTubeUrl(bad), null, bad);
});

test("youtube is a layer type with audio; embeds loop and mute unless audio is on", () => {
  assert.ok(LAYER_TYPES.includes("youtube"));
  assert.ok(AUDIO_TYPES.includes("youtube"));
  const layer = sanitiseLayer({ type:"youtube", config:{ url:"https://youtu.be/dQw4w9WgXcQ?t=30", videoId:"evilevilevi", start:999 } });
  assert.equal(layer.config.videoId, "dQw4w9WgXcQ", "the id always comes from the URL");
  assert.equal(layer.config.start, 30, "the start always comes from the URL");
  const muted = new URL(youtubeEmbedUrl(layer.config, { muted:true }));
  assert.equal(muted.origin + muted.pathname, "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(muted.searchParams.get("mute"), "1");
  assert.equal(muted.searchParams.get("playlist"), "dQw4w9WgXcQ", "single videos loop via playlist=<id>");
  assert.equal(new URL(youtubeEmbedUrl(layer.config, { muted:false })).searchParams.get("mute"), "0");
  assert.match(layerContent(layer, {}), /referrerpolicy="strict-origin-when-cross-origin"/, "YouTube needs a Referer (error 153 otherwise)");
  assert.equal(layerContent(sanitiseLayer({ type:"youtube", config:{ url:"https://evil.example/x" } }), {}), "");
});
