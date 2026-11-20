"use strict";

// One-time Twitch stream key import (purpose=stream_key), end to end against
// createApp() with Twitch's endpoints mocked.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.OAUTH_BROKER_PUBLIC_URL = "https://broker.example.com/oauth";
process.env.OAUTH_BROKER_SIGNING_SECRET = "x".repeat(40);
process.env.TWITCH_CLIENT_ID = "client-id";
process.env.TWITCH_CLIENT_SECRET = "client-secret";
process.env.YOUTUBE_CLIENT_ID = "yt-id";
process.env.YOUTUBE_CLIENT_SECRET = "yt-secret";
delete require.cache[require.resolve("./server")];
const { createApp, base64url, sha256 } = require("./server");

const realFetch = global.fetch;
const twitchCalls = [];
function mockTwitch(url, options = {}) {
  const href = String(url);
  twitchCalls.push({ href, options });
  const json = body => Promise.resolve(new Response(JSON.stringify(body), { status:200, headers:{ "Content-Type":"application/json" } }));
  if (href.startsWith("https://id.twitch.tv/oauth2/token")) return json({ access_token:"user-token", token_type:"bearer" });
  if (href.startsWith("https://api.twitch.tv/helix/users")) return json({ data:[{ id:"42", login:"streamer", display_name:"Streamer", profile_image_url:"https://x/a.png" }] });
  if (href.startsWith("https://api.twitch.tv/helix/streams/key")) return json({ data:[{ stream_key:"live_42_secret" }] });
  if (href.startsWith("https://id.twitch.tv/oauth2/revoke")) return Promise.resolve(new Response("", { status:200 }));
  return realFetch(url, options);
}

async function withBroker(fn) {
  global.fetch = mockTwitch;
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); global.fetch = realFetch; }
}

const post = (url, body) => realFetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) });

test("stream_key purpose asks for channel:read:stream_key and returns only the key", async () => {
  await withBroker(async base => {
    twitchCalls.length = 0;
    const verifier = base64url(crypto.randomBytes(32));
    const created = await post(`${base}/v1/transactions`, { provider:"twitch", codeChallenge:base64url(sha256(verifier)), purpose:"stream_key" });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const authorize = await realFetch(`${base}/authorize/${id}`, { redirect:"manual" });
    const location = new URL(authorize.headers.get("location"));
    assert.equal(location.searchParams.get("scope"), "channel:read:stream_key");
    assert.equal(location.searchParams.get("force_verify"), "true");

    const callback = await realFetch(`${base}/callback/twitch?code=abc&state=${encodeURIComponent(location.searchParams.get("state"))}`);
    assert.equal(callback.status, 200);

    const exchanged = await post(`${base}/v1/transactions/${id}/exchange`, { codeVerifier:verifier });
    const payload = await exchanged.json();
    assert.equal(payload.result.purpose, "stream_key");
    assert.equal(payload.result.streamKey, "live_42_secret");
    assert.equal(payload.result.user.id, "42");
    assert.equal(payload.result.brokerToken, undefined, "a key import must not mint a sign-in token");
    assert.ok(twitchCalls.some(c => c.href.includes("/helix/streams/key?broadcaster_id=42")));
    assert.ok(twitchCalls.some(c => c.href.startsWith("https://id.twitch.tv/oauth2/revoke")), "the one-time user token is revoked");
  });
});

test("normal sign-in keeps an empty scope; unknown purposes are refused", async () => {
  await withBroker(async base => {
    const challenge = base64url(sha256(base64url(crypto.randomBytes(32))));
    const { id } = await (await post(`${base}/v1/transactions`, { provider:"twitch", codeChallenge:challenge })).json();
    const location = new URL((await realFetch(`${base}/authorize/${id}`, { redirect:"manual" })).headers.get("location"));
    assert.equal(location.searchParams.get("scope"), "");
    assert.equal(location.searchParams.get("force_verify"), null);
    assert.equal((await post(`${base}/v1/transactions`, { provider:"twitch", codeChallenge:challenge, purpose:"bits" })).status, 400);
    assert.equal((await post(`${base}/v1/transactions`, { provider:"youtube", codeChallenge:challenge, purpose:"stream_key" })).status, 400);
  });
});
