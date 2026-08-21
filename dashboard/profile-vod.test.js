"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRemoteUrl, isYouTubeChallenge, ffmpegArgsFor } = require("./profile-vod");

test("remote VOD URL allowlist accepts YouTube/Twitch and rejects lookalikes", () => {
  assert.equal(normalizeRemoteUrl("youtube", "https://www.youtube.com/watch?v=abc123"), "https://www.youtube.com/watch?v=abc123");
  assert.equal(normalizeRemoteUrl("youtube", "https://youtu.be/abc123"), "https://youtu.be/abc123");
  assert.equal(normalizeRemoteUrl("youtube", "https://youtube.com.evil.example/watch?v=abc123"), null);
  assert.equal(normalizeRemoteUrl("twitch-vod", "https://www.twitch.tv/videos/123456789"), "https://www.twitch.tv/videos/123456789");
  assert.equal(normalizeRemoteUrl("twitch-vod", "https://evil.example/videos/123"), null);
});

test("Twitch live channel names normalize to canonical channel URLs", () => {
  assert.equal(normalizeRemoteUrl("twitch-live", "NekoSuneVR"), "https://www.twitch.tv/NekoSuneVR");
  assert.equal(normalizeRemoteUrl("twitch-live", "https://www.twitch.tv/NekoSuneVR"), "https://www.twitch.tv/NekoSuneVR");
  assert.equal(normalizeRemoteUrl("twitch-live", "https://www.twitch.tv/videos/123456789"), null);
});

test("YouTube bot/cookie challenges are classified without requesting cookies", () => {
  assert.equal(isYouTubeChallenge("Sign in to confirm you’re not a bot"), true);
  assert.equal(isYouTubeChallenge("ERROR: HTTP Error 403: Forbidden"), true);
  assert.equal(isYouTubeChallenge("ordinary extractor failure"), false);
});

test("Twitch HLS relay uses stream copy into private relay path", () => {
  const args = ffmpegArgsFor(
    { kind:"twitch-live", inputs:["https://usher.ttvnw.net/api/channel/hls/test.m3u8"] },
    "rtmp://127.0.0.1:1935/relay/pc-key"
  );
  assert.ok(args.includes("-c:v"));
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
  assert.equal(args.at(-1), "rtmp://127.0.0.1:1935/relay/pc-key");
  assert.equal(args.includes("-re"), false);
});

test("uploaded/YouTube VOD playback is paced and H264/AAC encoded", () => {
  const args = ffmpegArgsFor(
    { kind:"upload", inputs:["/tmp/test.mp4"] },
    "rtmp://127.0.0.1:1935/relay/pc-key"
  );
  assert.ok(args.includes("-re"));
  assert.equal(args[args.indexOf("-c:v") + 1], process.env.VOD_VIDEO_ENCODER || "libx264");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
});
