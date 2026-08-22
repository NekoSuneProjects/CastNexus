"use strict";

const crypto = require("node:crypto");

function base64url(value) { return Buffer.from(value).toString("base64url"); }
function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
function createHostedOauth({ brokerUrl, fetchImpl = global.fetch } = {}) {
  const base = String(brokerUrl || "").replace(/\/$/, "");
  function enabled() { return /^https:\/\//i.test(base); }
  async function request(path, options = {}) {
    const response = await fetchImpl(`${base}${path}`, { ...options, headers:{ "Content-Type":"application/json", ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) throw Object.assign(new Error(data.error || `OAuth broker request failed (${response.status})`), { status:response.status });
    return { status:response.status, data };
  }
  async function start(provider) {
    if (!enabled()) throw new Error("Hosted OAuth is not configured");
    const pkce = createPkce();
    const { data } = await request("/v1/transactions", { method:"POST", body:JSON.stringify({ provider, codeChallenge:pkce.challenge }) });
    return { provider, id:data.id, authorizationUrl:data.authorizationUrl, expiresAt:Date.now() + Number(data.expiresIn || 600) * 1000, verifier:pkce.verifier };
  }
  async function exchange(flow) {
    if (!flow?.id || !flow?.verifier) throw new Error("OAuth transaction is missing");
    const response = await request(`/v1/transactions/${encodeURIComponent(flow.id)}/exchange`, { method:"POST", body:JSON.stringify({ codeVerifier:flow.verifier }) });
    return response.status === 202 ? { pending:true } : { pending:false, ...response.data };
  }
  async function twitchHelix(resource, params = {}, brokerToken = "") {
    const url = new URL(`${base}/v1/twitch/helix/${resource}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, { headers:{ Authorization:`Bearer ${brokerToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `OAuth broker Twitch request failed (${response.status})`);
    return data;
  }
  async function youtubeRefresh(refreshToken) {
    const { data } = await request("/v1/youtube/refresh", { method:"POST", body:JSON.stringify({ refreshToken }) });
    return data;
  }
  return { enabled, start, exchange, twitchHelix, youtubeRefresh, baseUrl:base };
}

module.exports = { createHostedOauth, createPkce, base64url };
