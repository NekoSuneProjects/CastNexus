"use strict";

const crypto = require("node:crypto");
const express = require("express");

const PORT = Number(process.env.OAUTH_BROKER_PORT || 8091);
const PUBLIC_URL = String(process.env.OAUTH_BROKER_PUBLIC_URL || "").replace(/\/$/, "");
const SITE_URL = String(process.env.CASTNEXUS_SITE_URL || PUBLIC_URL.replace(/\/oauth$/, "")).replace(/\/$/, "");
const SIGNING_SECRET = process.env.OAUTH_BROKER_SIGNING_SECRET || "";
function brokerMountPath(publicUrl = PUBLIC_URL) {
  try {
    const pathname = new URL(publicUrl).pathname.replace(/\/$/, "");
    return pathname === "/" ? "" : pathname;
  } catch { return ""; }
}
function stripBrokerMount(url, mountPath = brokerMountPath()) {
  if (!mountPath || (url !== mountPath && !url.startsWith(`${mountPath}/`) && !url.startsWith(`${mountPath}?`))) return url;
  return url.slice(mountPath.length) || "/";
}
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";
const GOOGLE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || "";
// Kick (https://docs.kick.com): OAuth 2.1 with PKCE. Used to let CastNexus set
// the Kick stream title / category for the connected channel.
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || "";
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || "";
const KICK_SCOPE = "user:read channel:read channel:write";
const TRANSACTION_TTL_MS = Math.max(60_000, Number(process.env.OAUTH_TRANSACTION_TTL_MS || 10 * 60_000));
const TRUST_PROXY = process.env.OAUTH_TRUST_PROXY === "true" ? 1 : false;

const transactions = new Map();
const requestBuckets = new Map();
let twitchAppToken = null;
let twitchAppTokenExpiresAt = 0;

function base64url(value) { return Buffer.from(value).toString("base64url"); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest(); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function transactionId() { return base64url(crypto.randomBytes(24)); }
function oauthState(id) {
  const nonce = base64url(crypto.randomBytes(18));
  const body = `${id}.${nonce}`;
  const signature = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(body).digest());
  return `${body}.${signature}`;
}
function verifyOauthState(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(body).digest());
  return safeEqual(parts[2], expected) ? parts[0] : null;
}
function signBrokerToken(claims, ttlSeconds = 30 * 24 * 60 * 60) {
  const header = base64url(JSON.stringify({ alg:"HS256", typ:"JWT" }));
  const payload = base64url(JSON.stringify({ ...claims, iat:Math.floor(Date.now()/1000), exp:Math.floor(Date.now()/1000)+ttlSeconds }));
  const signature = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}
function verifyBrokerToken(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) return null;
  const expected = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(`${parts[0]}.${parts[1]}`).digest());
  if (!safeEqual(parts[2], expected)) return null;
  try { const claims=JSON.parse(Buffer.from(parts[1],"base64url")); return claims.exp>Date.now()/1000?claims:null; } catch { return null; }
}
function validChallenge(value) { return /^[A-Za-z0-9_-]{43}$/.test(String(value || "")); }
function providerConfigured(provider) {
  if (provider === "twitch") return !!(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET);
  if (provider === "youtube") return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  if (provider === "kick") return !!(KICK_CLIENT_ID && KICK_CLIENT_SECRET);
  return false;
}
function callbackUrl(provider) { return `${PUBLIC_URL}/callback/${provider}`; }
function pruneTransactions(now = Date.now()) {
  for (const [id, tx] of transactions) if (now - tx.createdAt > TRANSACTION_TTL_MS) transactions.delete(id);
}
function rateLimit({ windowMs = 60_000, limit = 30 } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    if (requestBuckets.size > 10_000) {
      for (const [bucketKey, old] of requestBuckets) if (now - old.startedAt >= windowMs) requestBuckets.delete(bucketKey);
    }
    const key = `${req.ip}:${req.path}`;
    let bucket = requestBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) bucket = { startedAt:now, count:0 };
    bucket.count += 1;
    requestBuckets.set(key, bucket);
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) return res.status(429).json({ error:"too many requests" });
    next();
  };
}
function securityHeaders(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action https://id.twitch.tv https://accounts.google.com https://id.kick.com");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (PUBLIC_URL.startsWith("https://")) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}
function resultPage(title, message, ok = true) {
  const accent = ok ? "#7c5cff" : "#ff667a";
  const esc = v => String(v).replace(/[&<>\"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '\"':"&quot;" }[c]));
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a12;color:#f4f6ff;font:16px system-ui}.card{max-width:520px;padding:38px;border:1px solid #292d3b;border-radius:24px;background:#10131f;text-align:center}h1{color:${accent}}p{color:#adb5ca;line-height:1.6}</style><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p></div>`;
}
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error_description || data.error || `provider request failed (${response.status})`);
  return data;
}
// Why a Twitch authorization was started:
//   login      - sign in to CastNexus (no Twitch scopes)
//   stream_key - one-time read of the broadcaster's stream key for Console
//                profiles (scope channel:read:stream_key). The user token is
//                used once, revoked immediately and never stored or returned.
//   channel_manage - lets CastNexus set the stream title / game (scope
//                channel:manage:broadcast). Like YouTube, the user's access +
//                refresh token go back to that user's CastNexus install, which
//                refreshes them through /v1/twitch/refresh. The broker keeps
//                nothing.
const TWITCH_PURPOSES = Object.freeze({
  login:{ scope:"" },
  stream_key:{ scope:"channel:read:stream_key", forceVerify:true },
  channel_manage:{ scope:"channel:manage:broadcast", forceVerify:true },
});
function twitchPurpose(value) {
  const purpose = String(value || "login");
  return Object.prototype.hasOwnProperty.call(TWITCH_PURPOSES, purpose) ? purpose : null;
}
async function revokeTwitchToken(accessToken) {
  try {
    await fetch("https://id.twitch.tv/oauth2/revoke", {
      method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body:new URLSearchParams({ client_id:TWITCH_CLIENT_ID, token:accessToken }),
    });
  } catch (error) { console.warn(`[oauth-broker] could not revoke a one-time Twitch token: ${error.message}`); }
}
async function exchangeTwitch(code, purpose = "login") {
  const token = await jsonRequest("https://id.twitch.tv/oauth2/token", {
    method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams({ client_id:TWITCH_CLIENT_ID, client_secret:TWITCH_CLIENT_SECRET, code, grant_type:"authorization_code", redirect_uri:callbackUrl("twitch") }),
  });
  const auth = { headers:{ Authorization:`Bearer ${token.access_token}`, "Client-Id":TWITCH_CLIENT_ID } };
  try {
    const users = await jsonRequest("https://api.twitch.tv/helix/users", auth);
    const user = users.data?.[0];
    if (!user) throw new Error("Twitch did not return an account");
    const profile = { id:user.id, login:user.login, displayName:user.display_name, profileImageUrl:user.profile_image_url };
    if (purpose === "stream_key") {
      const keys = await jsonRequest(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${encodeURIComponent(user.id)}`, auth);
      const streamKey = keys.data?.[0]?.stream_key;
      if (!streamKey) throw new Error("Twitch did not return a stream key");
      return { purpose, user:profile, streamKey };
    }
    if (purpose === "channel_manage") {
      // Client-Id is public; the dashboard needs it to call Helix with this token.
      return { purpose, user:profile, clientId:TWITCH_CLIENT_ID, accessToken:token.access_token, refreshToken:token.refresh_token, expiresIn:token.expires_in, scope:token.scope };
    }
    return { user:profile, brokerToken:signBrokerToken({ sub:user.id, login:user.login, scope:"twitch:read" }) };
  } finally {
    if (purpose === "stream_key") await revokeTwitchToken(token.access_token);
  }
}
async function exchangeYoutube(code) {
  return jsonRequest("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams({ client_id:GOOGLE_CLIENT_ID, client_secret:GOOGLE_CLIENT_SECRET, code, grant_type:"authorization_code", redirect_uri:callbackUrl("youtube") }),
  });
}
async function exchangeKick(code, codeVerifier) {
  const token = await jsonRequest("https://id.kick.com/oauth/token", {
    method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams({ grant_type:"authorization_code", client_id:KICK_CLIENT_ID, client_secret:KICK_CLIENT_SECRET, redirect_uri:callbackUrl("kick"), code_verifier:codeVerifier, code }),
  });
  const users = await jsonRequest("https://api.kick.com/public/v1/users", { headers:{ Authorization:`Bearer ${token.access_token}`, Accept:"application/json" } });
  const user = users.data?.[0];
  if (!user) throw new Error("Kick did not return an account");
  return {
    purpose:"channel_manage",
    user:{ id:String(user.user_id), login:String(user.name || ""), displayName:String(user.name || ""), profileImageUrl:user.profile_picture || "" },
    accessToken:token.access_token, refreshToken:token.refresh_token, expiresIn:token.expires_in, scope:token.scope,
  };
}
async function refreshToken(url, clientId, clientSecret, refresh) {
  return jsonRequest(url, {
    method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams({ grant_type:"refresh_token", refresh_token:refresh, client_id:clientId, client_secret:clientSecret }),
  });
}
function validRefreshToken(value) {
  const token = String(value || "");
  return token.length >= 20 && token.length <= 4096 ? token : null;
}
async function twitchApplicationToken() {
  if (twitchAppToken && Date.now() < twitchAppTokenExpiresAt - 60_000) return twitchAppToken;
  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", TWITCH_CLIENT_ID);
  url.searchParams.set("client_secret", TWITCH_CLIENT_SECRET);
  url.searchParams.set("grant_type", "client_credentials");
  const data = await jsonRequest(url, { method:"POST" });
  twitchAppToken = data.access_token;
  twitchAppTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return twitchAppToken;
}

function createApp() {
  if (!PUBLIC_URL || !PUBLIC_URL.startsWith("https://")) throw new Error("OAUTH_BROKER_PUBLIC_URL must be an HTTPS URL");
  if (SIGNING_SECRET.length < 32) throw new Error("OAUTH_BROKER_SIGNING_SECRET must be at least 32 characters");
  const app = express();
  if (TRUST_PROXY) app.set("trust proxy", TRUST_PROXY);
  app.disable("x-powered-by");
  // Support reverse proxies that either preserve or strip the public mount
  // path. This keeps /oauth portable across Nginx, OpenResty and managed
  // proxy configurations without exposing a second public service.
  app.use((req, _res, next) => {
    req.url = stripBrokerMount(req.url);
    next();
  });
  app.use(securityHeaders);
  app.use(express.json({ limit:"16kb", strict:true }));

  app.get("/", (_req, res) => res.json({ service:"CastNexus OAuth broker", ok:true, homepage:SITE_URL, privacy:`${SITE_URL}/privacy`, terms:`${SITE_URL}/terms` }));
  app.get("/health", (_req, res) => res.json({ ok:true, providers:{ twitch:providerConfigured("twitch"), youtube:providerConfigured("youtube"), kick:providerConfigured("kick") }, legal:{ privacy:`${SITE_URL}/privacy`, terms:`${SITE_URL}/terms` } }));
  app.post("/v1/transactions", rateLimit({ limit:20 }), (req, res) => {
    pruneTransactions();
    const provider = String(req.body?.provider || "");
    const codeChallenge = String(req.body?.codeChallenge || "");
    if (!providerConfigured(provider)) return res.status(503).json({ error:`${provider || "provider"} OAuth is not configured` });
    if (!validChallenge(codeChallenge)) return res.status(400).json({ error:"a valid S256 PKCE challenge is required" });
    const purpose = provider === "twitch" ? twitchPurpose(req.body?.purpose) : provider === "kick" ? "channel_manage" : (req.body?.purpose ? null : "login");
    if (!purpose) return res.status(400).json({ error:`unsupported purpose for ${provider}` });
    const id = transactionId();
    transactions.set(id, { id, provider, purpose, codeChallenge, createdAt:Date.now(), status:"pending", result:null, attempts:0 });
    res.status(201).json({ id, expiresIn:Math.floor(TRANSACTION_TTL_MS / 1000), authorizationUrl:`${PUBLIC_URL}/authorize/${id}` });
  });

  app.get("/authorize/:id", rateLimit({ limit:40 }), (req, res) => {
    pruneTransactions();
    const tx = transactions.get(req.params.id);
    if (!tx || tx.status !== "pending") return res.status(404).send(resultPage("Sign-in expired", "Start sign-in again from CastNexus.", false));
    const state = oauthState(tx.id);
    tx.stateHash = base64url(sha256(state));
    if (tx.provider === "twitch") {
      const url = new URL("https://id.twitch.tv/oauth2/authorize");
      const purpose = TWITCH_PURPOSES[tx.purpose] || TWITCH_PURPOSES.login;
      url.search = new URLSearchParams({ client_id:TWITCH_CLIENT_ID, redirect_uri:callbackUrl("twitch"), response_type:"code", scope:purpose.scope, state, ...(purpose.forceVerify ? { force_verify:"true" } : {}) }).toString();
      return res.redirect(302, url.toString());
    }
    if (tx.provider === "kick") {
      // Kick requires PKCE between the broker and Kick (separate from the
      // dashboard <-> broker PKCE pair).
      tx.kickVerifier = base64url(crypto.randomBytes(32));
      const url = new URL("https://id.kick.com/oauth/authorize");
      url.search = new URLSearchParams({ client_id:KICK_CLIENT_ID, redirect_uri:callbackUrl("kick"), response_type:"code", scope:KICK_SCOPE, state, code_challenge:base64url(sha256(tx.kickVerifier)), code_challenge_method:"S256" }).toString();
      return res.redirect(302, url.toString());
    }
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id:GOOGLE_CLIENT_ID, redirect_uri:callbackUrl("youtube"), response_type:"code", scope:"https://www.googleapis.com/auth/youtube.upload", access_type:"offline", prompt:"consent", state }).toString();
    res.redirect(302, url.toString());
  });

  async function providerCallback(req, res, provider) {
    const id = verifyOauthState(req.query.state);
    const tx = id ? transactions.get(id) : null;
    if (!tx || tx.provider !== provider || !safeEqual(tx.stateHash, base64url(sha256(req.query.state || "")))) return res.status(400).send(resultPage("Sign-in rejected", "The authorization state was invalid or expired.", false));
    if (tx.status !== "pending") return res.status(409).send(resultPage("Already completed", "This authorization request has already been used.", false));
    if (req.query.error) {
      tx.status = "error";
      tx.error = String(req.query.error_description || req.query.error).slice(0, 300);
      return res.status(400).send(resultPage("Authorization declined", tx.error, false));
    }
    if (!req.query.code) return res.status(400).send(resultPage("Sign-in rejected", "The provider did not return an authorization code.", false));
    try {
      tx.result = provider === "twitch" ? await exchangeTwitch(String(req.query.code), tx.purpose)
        : provider === "kick" ? await exchangeKick(String(req.query.code), tx.kickVerifier)
        : await exchangeYoutube(String(req.query.code));
      tx.status = "complete";
      res.send(resultPage("Connected to CastNexus", "Authorization is complete. Return to your CastNexus window; it will finish automatically."));
    } catch (error) {
      console.error(`[oauth-broker] ${provider} callback failed: ${error.message}`);
      tx.status = "error";
      tx.error = "The provider authorization could not be completed.";
      res.status(502).send(resultPage("Authorization failed", tx.error, false));
    }
  }
  app.get("/callback/twitch", rateLimit({ limit:60 }), (req, res) => providerCallback(req, res, "twitch"));
  app.get("/callback/youtube", rateLimit({ limit:60 }), (req, res) => providerCallback(req, res, "youtube"));
  app.get("/callback/kick", rateLimit({ limit:60 }), (req, res) => providerCallback(req, res, "kick"));

  app.post("/v1/transactions/:id/exchange", rateLimit({ limit:60 }), (req, res) => {
    pruneTransactions();
    const tx = transactions.get(req.params.id);
    if (!tx) return res.status(404).json({ error:"authorization request expired" });
    const verifier = String(req.body?.codeVerifier || "");
    const challenge = base64url(sha256(verifier));
    if (!safeEqual(challenge, tx.codeChallenge)) {
      tx.attempts += 1;
      if (tx.attempts > 10) { transactions.delete(tx.id); return res.status(429).json({ error:"authorization exchange locked" }); }
      return res.status(403).json({ error:"PKCE verification failed" });
    }
    if (tx.status === "pending") return res.status(202).json({ status:"pending" });
    if (tx.status === "error") { transactions.delete(tx.id); return res.status(400).json({ error:tx.error || "authorization failed" }); }
    const payload = { provider:tx.provider, result:tx.result };
    transactions.delete(tx.id);
    res.json(payload);
  });

  app.get("/v1/twitch/helix/:resource", rateLimit({ limit:120 }), async (req, res) => {
    if (!providerConfigured("twitch")) return res.status(503).json({ error:"Twitch is unavailable" });
    const claims = verifyBrokerToken(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!claims || claims.scope !== "twitch:read") return res.status(401).json({ error:"a valid CastNexus broker token is required" });
    if (!["streams", "videos"].includes(req.params.resource)) return res.status(404).json({ error:"unsupported Twitch resource" });
    try {
      const token = await twitchApplicationToken();
      const url = new URL(`https://api.twitch.tv/helix/${req.params.resource}`);
      for (const [key, value] of Object.entries(req.query)) if (["user_id", "user_login", "first", "type"].includes(key)) url.searchParams.set(key, String(value));
      const response = await fetch(url, { headers:{ "Client-Id":TWITCH_CLIENT_ID, Authorization:`Bearer ${token}` } });
      const data = await response.json().catch(() => ({}));
      res.status(response.status).json(data);
    } catch (error) { res.status(502).json({ error:error.message }); }
  });

  // Refresh a user's channel_manage token (Twitch rotates refresh tokens, so
  // the response includes the new one).
  app.post("/v1/twitch/refresh", rateLimit({ limit:30 }), async (req, res) => {
    if (!providerConfigured("twitch")) return res.status(503).json({ error:"Twitch is unavailable" });
    const refresh = validRefreshToken(req.body?.refreshToken);
    if (!refresh) return res.status(400).json({ error:"a valid refresh token is required" });
    try {
      const data = await refreshToken("https://id.twitch.tv/oauth2/token", TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, refresh);
      res.json({ access_token:data.access_token, refresh_token:data.refresh_token, expires_in:data.expires_in, scope:data.scope, client_id:TWITCH_CLIENT_ID });
    } catch (error) { res.status(400).json({ error:error.message }); }
  });
  app.post("/v1/kick/refresh", rateLimit({ limit:30 }), async (req, res) => {
    if (!providerConfigured("kick")) return res.status(503).json({ error:"Kick is unavailable" });
    const refresh = validRefreshToken(req.body?.refreshToken);
    if (!refresh) return res.status(400).json({ error:"a valid refresh token is required" });
    try {
      const data = await refreshToken("https://id.kick.com/oauth/token", KICK_CLIENT_ID, KICK_CLIENT_SECRET, refresh);
      res.json({ access_token:data.access_token, refresh_token:data.refresh_token, expires_in:data.expires_in, scope:data.scope });
    } catch (error) { res.status(400).json({ error:error.message }); }
  });

  app.post("/v1/youtube/refresh", rateLimit({ limit:30 }), async (req, res) => {
    if (!providerConfigured("youtube")) return res.status(503).json({ error:"YouTube is unavailable" });
    const refreshToken = String(req.body?.refreshToken || "");
    if (refreshToken.length < 20 || refreshToken.length > 4096) return res.status(400).json({ error:"a valid refresh token is required" });
    try {
      const data = await jsonRequest("https://oauth2.googleapis.com/token", {
        method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
        body:new URLSearchParams({ client_id:GOOGLE_CLIENT_ID, client_secret:GOOGLE_CLIENT_SECRET, refresh_token:refreshToken, grant_type:"refresh_token" }),
      });
      res.json({ access_token:data.access_token, expires_in:data.expires_in, scope:data.scope, token_type:data.token_type });
    } catch (error) { res.status(400).json({ error:error.message }); }
  });

  app.use((_req, res) => res.status(404).json({ error:"not found" }));
  app.use((error, _req, res, _next) => {
    console.error(`[oauth-broker] ${error.message}`);
    res.status(error.type === "entity.too.large" ? 413 : 400).json({ error:"invalid request" });
  });
  return app;
}

if (require.main === module) {
  try { createApp().listen(PORT, "0.0.0.0", () => console.log(`[oauth-broker] listening on :${PORT} as ${PUBLIC_URL}`)); }
  catch (error) { console.error(`[oauth-broker] ${error.message}`); process.exit(1); }
}

module.exports = { createApp, twitchPurpose, TWITCH_PURPOSES, providerConfigured, KICK_SCOPE, base64url, sha256, safeEqual, verifyOauthState, validChallenge, signBrokerToken, verifyBrokerToken, brokerMountPath, stripBrokerMount };
