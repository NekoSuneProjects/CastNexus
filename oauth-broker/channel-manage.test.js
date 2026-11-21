"use strict";

// Stream title / category management: Twitch channel_manage purpose and the
// Kick provider (OAuth 2.1 + PKCE).

process.env.OAUTH_BROKER_PUBLIC_URL = "https://broker.example.test/oauth";
process.env.OAUTH_BROKER_SIGNING_SECRET = "s".repeat(40);
process.env.TWITCH_CLIENT_ID = "twitch-client";
process.env.TWITCH_CLIENT_SECRET = "twitch-secret";
process.env.KICK_CLIENT_ID = "kick-client";
process.env.KICK_CLIENT_SECRET = "kick-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createApp, base64url, sha256, TWITCH_PURPOSES, providerConfigured, KICK_SCOPE } = require("./server");

async function withServer(fn) {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

async function startTransaction(base, body) {
  const challenge = base64url(sha256(base64url(crypto.randomBytes(32))));
  const res = await fetch(`${base}/v1/transactions`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ codeChallenge:challenge, ...body }) });
  return { res, data:await res.json() };
}

async function authorizeRedirect(base, id) {
  const res = await fetch(`${base}/authorize/${id}`, { redirect:"manual" });
  assert.equal(res.status, 302);
  return new URL(res.headers.get("location"));
}

test("Twitch channel_manage asks only for channel:manage:broadcast", async () => {
  assert.equal(TWITCH_PURPOSES.channel_manage.scope, "channel:manage:broadcast");
  await withServer(async base => {
    const { res, data } = await startTransaction(base, { provider:"twitch", purpose:"channel_manage" });
    assert.equal(res.status, 201);
    const url = await authorizeRedirect(base, data.id);
    assert.equal(url.origin, "https://id.twitch.tv");
    assert.equal(url.searchParams.get("scope"), "channel:manage:broadcast");
    assert.equal(url.searchParams.get("force_verify"), "true");
  });
});

test("Kick authorization uses PKCE S256 and the channel scopes", async () => {
  assert.equal(providerConfigured("kick"), true);
  await withServer(async base => {
    const { res, data } = await startTransaction(base, { provider:"kick" });
    assert.equal(res.status, 201);
    const url = await authorizeRedirect(base, data.id);
    assert.equal(url.origin + url.pathname, "https://id.kick.com/oauth/authorize");
    assert.equal(url.searchParams.get("scope"), KICK_SCOPE);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(url.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(url.searchParams.get("redirect_uri"), "https://broker.example.test/oauth/callback/kick");
  });
});

test("unknown Twitch purposes and bad refresh tokens are refused", async () => {
  await withServer(async base => {
    const { res } = await startTransaction(base, { provider:"twitch", purpose:"everything" });
    assert.equal(res.status, 400);
    for (const provider of ["twitch", "kick"]) {
      const r = await fetch(`${base}/v1/${provider}/refresh`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ refreshToken:"short" }) });
      assert.equal(r.status, 400);
    }
  });
});
