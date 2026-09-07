"use strict";

const crypto = require("node:crypto");
const express = require("express");

const PORT = Number(process.env.RELAYSTREAM_PORT || 8092);
const PUBLIC_URL = String(process.env.RELAYSTREAM_PUBLIC_URL || "").replace(/\/$/, "");
const SIGNING_SECRET = process.env.RELAYSTREAM_SIGNING_SECRET || "";
const ADMIN_TOKEN = process.env.RELAYSTREAM_ADMIN_TOKEN || "";
const MEDIAMTX_API = process.env.MEDIAMTX_API || "http://127.0.0.1:9997";
const TRUST_PROXY = process.env.RELAYSTREAM_TRUST_PROXY === "true" ? 1 : false;
const PUSH_TOKEN_TTL_MS = Math.max(60_000, Number(process.env.RELAYSTREAM_PUSH_TOKEN_TTL_MS || 6 * 60 * 60_000));
const NODE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const nodes = new Map();
const requestBuckets = new Map();

function base64url(value) { return Buffer.from(value).toString("base64url"); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function validNodeId(value) { return NODE_ID_RE.test(String(value || "")); }
function signPushToken(nodeId, ttlMs = PUSH_TOKEN_TTL_MS) {
  const header = base64url(JSON.stringify({ alg:"HS256", typ:"JWT" }));
  const payload = base64url(JSON.stringify({ nodeId, iat:Math.floor(Date.now()/1000), exp:Math.floor((Date.now()+ttlMs)/1000) }));
  const signature = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}
function verifyPushToken(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) return null;
  const expected = base64url(crypto.createHmac("sha256", SIGNING_SECRET).update(`${parts[0]}.${parts[1]}`).digest());
  if (!safeEqual(parts[2], expected)) return null;
  try { const claims = JSON.parse(Buffer.from(parts[1], "base64url")); return claims.exp > Date.now()/1000 ? claims : null; } catch { return null; }
}
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error:"admin API is not configured" });
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(token, ADMIN_TOKEN)) return res.status(401).json({ error:"a valid admin token is required" });
  next();
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
  res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  if (PUBLIC_URL.startsWith("https://")) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}
function ensureNode(nodeId) {
  let node = nodes.get(nodeId);
  if (!node) {
    node = { id:nodeId, banned:false, firstSeenAt:Date.now(), lastSeenAt:Date.now(), lastPublishAt:null };
    nodes.set(nodeId, node);
  }
  return node;
}
async function mediamtxRequest(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(data?.error || `MediaMTX request failed (${res.status})`);
  return data;
}
async function liveNodeIds() {
  try {
    const data = await mediamtxRequest(`${MEDIAMTX_API}/v3/paths/list`);
    const live = new Set();
    for (const item of data?.items || []) {
      const match = String(item.name || "").match(/^(?:push|whip)\/([A-Za-z0-9-]{8,64})$/);
      if (match && item.ready) live.add(match[1]);
    }
    return live;
  } catch { return new Set(); }
}

function createApp() {
  if (SIGNING_SECRET.length < 32) throw new Error("RELAYSTREAM_SIGNING_SECRET must be at least 32 characters");
  const app = express();
  if (TRUST_PROXY) app.set("trust proxy", TRUST_PROXY);
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(express.json({ limit:"16kb", strict:true }));
  app.use(express.urlencoded({ extended:false, limit:"16kb" }));

  app.get("/", (_req, res) => res.json({ service:"CastNexus relaystream", ok:true }));
  app.get("/health", (_req, res) => res.json({ ok:true, nodes:nodes.size }));

  app.post("/v1/nodes/register", rateLimit({ limit:30 }), (req, res) => {
    const nodeId = String(req.body?.nodeId || "");
    if (!validNodeId(nodeId)) return res.status(400).json({ error:"a valid nodeId is required" });
    const node = ensureNode(nodeId);
    if (node.banned) return res.status(403).json({ error:"this node has been banned from relaystream" });
    node.lastSeenAt = Date.now();
    res.json({
      nodeId,
      pushToken:signPushToken(nodeId),
      expiresIn:Math.floor(PUSH_TOKEN_TTL_MS / 1000),
      rtmpUrl:`rtmp://${req.hostname}:1936/push/${nodeId}`,
      whipUrl:`${PUBLIC_URL || `https://${req.hostname}`}/whip/${nodeId}`,
      watchUrl:`${PUBLIC_URL || `https://${req.hostname}`}/relay/${nodeId}`,
    });
  });

  // MediaMTX authHTTPAddress webhook - called on every publish/read attempt.
  // Publish requires a valid, unexpired push token matching the path's nodeId;
  // playback (public viewing) is always allowed unless the node is banned.
  app.post("/mtx-auth", rateLimit({ limit:600 }), (req, res) => {
    const body = req.body || {};
    const path = String(body.path || "");
    const action = String(body.action || "");
    const match = path.match(/^(?:push|whip)\/([A-Za-z0-9-]{8,64})$/);
    if (!match) return res.status(404).end();
    const nodeId = match[1];
    const node = nodes.get(nodeId);
    if (node?.banned) return res.status(403).end();

    if (action === "publish") {
      const params = new URLSearchParams(String(body.query || ""));
      const token = params.get("token") || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const claims = verifyPushToken(token);
      if (!claims || claims.nodeId !== nodeId) return res.status(401).end();
      const publishing = ensureNode(nodeId);
      publishing.lastSeenAt = Date.now();
      publishing.lastPublishAt = Date.now();
      return res.status(200).end();
    }
    return res.status(200).end();
  });

  app.get("/v1/admin/nodes", requireAdmin, async (_req, res) => {
    const live = await liveNodeIds();
    res.json({
      nodes:[...nodes.values()].map(n => ({ ...n, live:live.has(n.id) })),
    });
  });
  app.post("/v1/admin/nodes/:id/ban", requireAdmin, (req, res) => {
    const node = ensureNode(req.params.id);
    node.banned = true;
    res.json({ ok:true, node });
  });
  app.post("/v1/admin/nodes/:id/unban", requireAdmin, (req, res) => {
    const node = nodes.get(req.params.id);
    if (!node) return res.status(404).json({ error:"unknown node" });
    node.banned = false;
    res.json({ ok:true, node });
  });

  app.use((_req, res) => res.status(404).json({ error:"not found" }));
  app.use((error, _req, res, _next) => {
    console.error(`[relaystream] ${error.message}`);
    res.status(error.type === "entity.too.large" ? 413 : 400).json({ error:"invalid request" });
  });
  return app;
}

if (require.main === module) {
  try { createApp().listen(PORT, "0.0.0.0", () => console.log(`[relaystream] listening on :${PORT}`)); }
  catch (error) { console.error(`[relaystream] ${error.message}`); process.exit(1); }
}

module.exports = { createApp, validNodeId, signPushToken, verifyPushToken, safeEqual };
