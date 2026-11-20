"use strict";

// Discord account linking + Discord OAuth2 helpers.
//
// Two uses, both with the SAME Discord application as the Activity:
//
// 1. Studio -> Settings -> "Link Discord": a normal OAuth2 code flow with the
//    `identify` scope. It stores the Discord user id on the CastNexus account,
//    so the Discord Activity can recognise that person in a voice channel.
//    Redirect URI to register in the Discord Developer Portal (OAuth2 tab):
//        https://<your domain>/auth/discord/callback
//
// 2. Inside the Activity: the Embedded App SDK's authorize() returns a code
//    which /activity/api/token exchanges for an access token (identify +
//    guilds). The Activity then reads who is in the voice channel and asks
//    /activity/api/voice-live which of them are linked and live.
//
// Needs DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET. The secret never leaves
// the server; access tokens are never stored.

const crypto = require("node:crypto");

const DISCORD_API = "https://discord.com/api/v10";

function discordOauthConfig(env = process.env) {
  const clientId = String(env.DISCORD_CLIENT_ID || "").trim();
  const clientSecret = String(env.DISCORD_CLIENT_SECRET || "").trim();
  return {
    clientId:/^\d{15,25}$/.test(clientId) ? clientId : "",
    clientSecret,
    enabled:/^\d{15,25}$/.test(clientId) && clientSecret.length >= 16,
    redirectUri:String(env.DISCORD_REDIRECT_URI || "").trim(),
  };
}

function createDiscordApi({ config, fetchImpl = (...args) => global.fetch(...args) } = {}) {
  async function exchangeCode(code, redirectUri) {
    const body = new URLSearchParams({ client_id:config.clientId, client_secret:config.clientSecret, grant_type:"authorization_code", code:String(code || "") });
    if (redirectUri) body.set("redirect_uri", redirectUri);
    const res = await fetchImpl(`${DISCORD_API}/oauth2/token`, { method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw Object.assign(new Error(data.error_description || data.error || `Discord token exchange failed (${res.status})`), { status:400 });
    return data;
  }

  async function me(accessToken) {
    const res = await fetchImpl(`${DISCORD_API}/users/@me`, { headers:{ Authorization:`Bearer ${accessToken}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) throw Object.assign(new Error("Discord did not accept the access token"), { status:401 });
    return { id:String(data.id), username:data.username || null, globalName:data.global_name || null, avatar:data.avatar || null };
  }

  async function revoke(accessToken) {
    try {
      await fetchImpl(`${DISCORD_API}/oauth2/token/revoke`, {
        method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
        body:new URLSearchParams({ client_id:config.clientId, client_secret:config.clientSecret, token:accessToken, token_type_hint:"access_token" }),
      });
    } catch {}
  }

  // Activity viewers send their access token with each voice-live request.
  // Cache the identity for a few minutes so polling doesn't hit Discord.
  const tokenCache = new Map();
  async function viewerFor(accessToken) {
    const token = String(accessToken || "");
    if (token.length < 20 || token.length > 200) throw Object.assign(new Error("a Discord access token is required"), { status:401 });
    const key = crypto.createHash("sha256").update(token).digest("base64url");
    const hit = tokenCache.get(key);
    if (hit && hit.until > Date.now()) return hit.user;
    const user = await me(token);
    tokenCache.set(key, { user, until:Date.now() + 5 * 60 * 1000 });
    if (tokenCache.size > 2000) for (const [k, v] of tokenCache) if (v.until <= Date.now()) tokenCache.delete(k);
    return user;
  }

  return { exchangeCode, me, revoke, viewerFor };
}

function publicDiscordLink(account) {
  const d = account?.discord;
  if (!d?.id) return null;
  return { id:d.id, username:d.username || null, globalName:d.globalName || null, linkedAt:d.linkedAt || null, visible:account.discordActivityVisible !== false };
}

// Links a Discord identity to `account`, removing it from any other account
// first (one Discord user = one CastNexus account).
function linkDiscord(state, account, discordUser) {
  for (const other of Object.values(state.accounts || {})) {
    if (other !== account && other?.discord?.id === discordUser.id) delete other.discord;
  }
  account.discord = { id:discordUser.id, username:discordUser.username, globalName:discordUser.globalName, linkedAt:new Date().toISOString() };
  if (account.discordActivityVisible === undefined) account.discordActivityVisible = true;
}

// CastNexus accounts that are linked to one of `discordIds`, opted in, and
// live right now. `rows(account)` builds the public channel row.
function liveLinkedChannels(state, discordIds, { isLive, row }) {
  const wanted = new Set((discordIds || []).map(String));
  const out = [];
  for (const account of Object.values(state.accounts || {})) {
    if (!account?.discord?.id || !wanted.has(String(account.discord.id))) continue;
    if (account.discordActivityVisible === false || account.blocked) continue;
    if (!isLive(account)) continue;
    out.push({ ...row(account), discordId:account.discord.id });
  }
  return out;
}

module.exports = { discordOauthConfig, createDiscordApi, publicDiscordLink, linkDiscord, liveLinkedChannels, DISCORD_API };
