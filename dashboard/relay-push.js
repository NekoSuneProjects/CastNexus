"use strict";

const RELAY_DESTINATION_ID = "relaystream";

function relaystreamBaseUrl() {
  return String(process.env.RELAYSTREAM_URL || "").replace(/\/$/, "");
}

const tokenCache = new Map();

async function registerNode(nodeId, { baseUrl = relaystreamBaseUrl() } = {}) {
  if (!baseUrl) throw new Error("RELAYSTREAM_URL is not configured");
  const res = await fetch(`${baseUrl}/v1/nodes/register`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ nodeId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `relaystream registration failed (${res.status})`);
  return data;
}

// Push tokens are short-lived (see relaystream's RELAYSTREAM_PUSH_TOKEN_TTL_MS)
// so they're cached per node and refreshed a minute before expiry, the same
// idiom as oauth-broker's cached Twitch app token.
async function ensurePushRegistration(nodeId, options = {}) {
  const cached = tokenCache.get(nodeId);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached;
  const data = await registerNode(nodeId, options);
  const entry = { ...data, expiresAt:Date.now() + Number(data.expiresIn || 0) * 1000 };
  tokenCache.set(nodeId, entry);
  return entry;
}

function pushUrlFor(registration, mode) {
  if (mode === "whip") return `${registration.whipUrl}?token=${encodeURIComponent(registration.pushToken)}`;
  return `${registration.rtmpUrl}?token=${encodeURIComponent(registration.pushToken)}`;
}

// Builds a destination-shaped object usable directly with startDestination/
// destinationFfmpegArgs, without it ever being a user-editable row in
// account.destinations.
async function relayDestinationFor(account, options = {}) {
  if (!account.relayPushEnabled) return null;
  const mode = account.relayPushMode === "whip" ? "whip" : "rtmp";
  const registration = await ensurePushRegistration(account.relayNodeId, options);
  return {
    id:RELAY_DESTINATION_ID,
    name:"Public Relay",
    url:pushUrlFor(registration, mode),
    layout:"source",
    enabled:true,
    transport:mode,
    watchUrl:registration.watchUrl,
  };
}

// Synchronous lookup used by the ffmpeg-exit auto-restart/CPU-fallback retry
// path (which cannot await a fresh registration call): reuses the
// already-cached token/registration if it's still valid, or returns null.
function cachedRelayDestination(account) {
  if (!account.relayPushEnabled) return null;
  const cached = tokenCache.get(account.relayNodeId);
  if (!cached || Date.now() >= cached.expiresAt) return null;
  const mode = account.relayPushMode === "whip" ? "whip" : "rtmp";
  return {
    id:RELAY_DESTINATION_ID,
    name:"Public Relay",
    url:pushUrlFor(cached, mode),
    layout:"source",
    enabled:true,
    transport:mode,
    watchUrl:cached.watchUrl,
  };
}

module.exports = { RELAY_DESTINATION_ID, relaystreamBaseUrl, registerNode, ensurePushRegistration, relayDestinationFor, cachedRelayDestination, pushUrlFor, tokenCache };
