"use strict";

// Stream title + game/category on the platforms CastNexus streams to.
//
// Each platform is connected through the CastNexus oauth-broker (Twitch
// purpose "channel_manage", Kick OAuth 2.1). The broker hands the user's
// access + refresh token back once; they live on the account like the YouTube
// upload tokens, and are refreshed through the broker when they expire.
//
//   account.channelConnections = {
//     twitch: { userId, login, clientId, accessToken, refreshToken, expiresAt, scope, connectedAt },
//     kick:   { userId, login, accessToken, refreshToken, expiresAt, scope, connectedAt },
//   }

const PROVIDERS = Object.freeze({
  twitch:{ label:"Twitch", categoryLabel:"Game / category" },
  kick:{ label:"Kick", categoryLabel:"Category" },
});
const TITLE_MAX = { twitch:140, kick:100 };
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

class ChannelInfoError extends Error {
  constructor(message, { status = 400, code = "CHANNEL_INFO_FAILED", provider = null } = {}) {
    super(message);
    this.status = status; this.code = code; this.provider = provider;
  }
}

function createChannelInfoService({ state, saveState, hostedOauth, fetchImpl = global.fetch, now = () => Date.now() }) {
  function connections(account) {
    if (!account.channelConnections || typeof account.channelConnections !== "object") account.channelConnections = {};
    return account.channelConnections;
  }

  function knownProvider(provider) {
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) throw new ChannelInfoError(`unknown platform "${provider}"`, { status:404, code:"UNKNOWN_PROVIDER" });
    return provider;
  }

  // Store the result of a hosted OAuth exchange. Twitch must be the same
  // account the user signed in to CastNexus with.
  function storeConnection(account, provider, result) {
    knownProvider(provider);
    if (!result?.accessToken) throw new ChannelInfoError("The OAuth broker did not return a token. It may be an older broker version - update the oauth-broker.", { status:502, code:"BROKER_OUTDATED", provider });
    if (provider === "twitch" && String(result.user?.id || "") !== String(account.twitchUserId)) {
      throw new ChannelInfoError(`You authorised the Twitch account "${result.user?.login || "unknown"}", but you are signed in to CastNexus as "${account.twitchLogin}". Log in to Twitch as ${account.twitchLogin} and try again.`, { status:403, code:"ACCOUNT_MISMATCH", provider });
    }
    connections(account)[provider] = {
      userId:String(result.user?.id || ""),
      login:String(result.user?.login || result.user?.displayName || ""),
      ...(provider === "twitch" ? { clientId:String(result.clientId || "") } : {}),
      accessToken:String(result.accessToken),
      refreshToken:String(result.refreshToken || ""),
      expiresAt:now() + Math.max(60, Number(result.expiresIn) || 3600) * 1000,
      scope:Array.isArray(result.scope) ? result.scope.join(" ") : String(result.scope || ""),
      connectedAt:new Date(now()).toISOString(),
    };
    saveState(state);
    return publicConnection(provider, connections(account)[provider]);
  }

  function disconnect(account, provider) {
    knownProvider(provider);
    delete connections(account)[provider];
    saveState(state);
  }

  function publicConnection(provider, c) {
    return c ? { provider, label:PROVIDERS[provider].label, connected:true, login:c.login, connectedAt:c.connectedAt } : { provider, label:PROVIDERS[provider].label, connected:false };
  }

  async function refresh(account, provider, { force = false } = {}) {
    const c = connections(account)[provider];
    if (!c) throw new ChannelInfoError(`${PROVIDERS[provider].label} is not connected`, { status:409, code:"NOT_CONNECTED", provider });
    if (!force && c.expiresAt - now() > REFRESH_MARGIN_MS) return c;
    if (!c.refreshToken) throw new ChannelInfoError(`${PROVIDERS[provider].label} sign-in expired - connect it again`, { status:401, code:"RECONNECT", provider });
    let data;
    try { data = provider === "twitch" ? await hostedOauth.twitchRefresh(c.refreshToken) : await hostedOauth.kickRefresh(c.refreshToken); }
    catch (err) { throw new ChannelInfoError(`${PROVIDERS[provider].label} sign-in expired - connect it again (${err.message})`, { status:401, code:"RECONNECT", provider }); }
    if (!data?.access_token) throw new ChannelInfoError(`${PROVIDERS[provider].label} did not refresh the sign-in - connect it again`, { status:401, code:"RECONNECT", provider });
    c.accessToken = data.access_token;
    if (data.refresh_token) c.refreshToken = data.refresh_token;
    if (data.client_id && provider === "twitch") c.clientId = data.client_id;
    c.expiresAt = now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
    saveState(state);
    return c;
  }

  // Authorised request with one refresh-and-retry on 401.
  async function call(account, provider, url, options = {}) {
    let c = await refresh(account, provider);
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { Accept:"application/json", Authorization:`Bearer ${c.accessToken}`, ...(options.body ? { "Content-Type":"application/json" } : {}), ...(provider === "twitch" ? { "Client-Id":c.clientId } : {}) };
      const res = await fetchImpl(url, { ...options, headers });
      if (res.status === 401 && attempt === 0) { c = await refresh(account, provider, { force:true }); continue; }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!res.ok) {
        const message = data?.message || data?.error || text || `request failed (${res.status})`;
        throw new ChannelInfoError(`${PROVIDERS[provider].label}: ${String(message).slice(0, 300)}`, { status:res.status === 401 || res.status === 403 ? 403 : 502, code:"PROVIDER_ERROR", provider });
      }
      return data;
    }
    throw new ChannelInfoError(`${PROVIDERS[provider].label} rejected the sign-in - connect it again`, { status:401, code:"RECONNECT", provider });
  }

  // ------------------------------------------------------------- Twitch
  const twitch = {
    async get(account) {
      const c = connections(account).twitch;
      const data = await call(account, "twitch", `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(c.userId)}`);
      const ch = data?.data?.[0] || {};
      return { title:ch.title || "", category:ch.game_id ? { id:String(ch.game_id), name:ch.game_name || "" } : null };
    },
    async search(account, query) {
      const data = await call(account, "twitch", `https://api.twitch.tv/helix/search/categories?first=20&query=${encodeURIComponent(query)}`);
      return (data?.data || []).map(g => ({ id:String(g.id), name:g.name, image:String(g.box_art_url || "").replace("{width}", "52").replace("{height}", "72") }));
    },
    async update(account, { title, categoryId }) {
      const c = connections(account).twitch;
      const body = {};
      if (title !== undefined) body.title = title;
      if (categoryId !== undefined) body.game_id = categoryId || "0"; // "0"/"" clears the game
      await call(account, "twitch", `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(c.userId)}`, { method:"PATCH", body:JSON.stringify(body) });
    },
  };

  // --------------------------------------------------------------- Kick
  const KICK_API = "https://api.kick.com/public";
  const kick = {
    async get(account) {
      const data = await call(account, "kick", `${KICK_API}/v1/channels`);
      const ch = data?.data?.[0] || {};
      return { title:ch.stream_title || "", category:ch.category?.id ? { id:String(ch.category.id), name:ch.category.name || "" } : null };
    },
    async search(account, query) {
      // v2 is Kick's current category search; fall back to v1 for older API versions.
      let data;
      try { data = await call(account, "kick", `${KICK_API}/v2/categories?limit=20&name=${encodeURIComponent(query)}`); }
      catch { data = await call(account, "kick", `${KICK_API}/v1/categories?q=${encodeURIComponent(query)}`); }
      return (data?.data || []).map(g => ({ id:String(g.id), name:g.name, image:g.thumbnail || "" }));
    },
    async update(account, { title, categoryId }) {
      const body = {};
      if (title !== undefined) body.stream_title = title;
      if (categoryId) body.category_id = Number(categoryId);
      if (!Object.keys(body).length) return;
      await call(account, "kick", `${KICK_API}/v1/channels`, { method:"PATCH", body:JSON.stringify(body) });
    },
  };
  const api = { twitch, kick };

  function status(account) {
    return Object.keys(PROVIDERS).map(p => publicConnection(p, connections(account)[p]));
  }

  async function current(account) {
    const out = {};
    for (const p of Object.keys(PROVIDERS)) {
      if (!connections(account)[p]) continue;
      try { out[p] = await api[p].get(account); }
      catch (err) { out[p] = { error:err.message, code:err.code }; }
    }
    return out;
  }

  async function searchCategories(account, provider, query) {
    knownProvider(provider);
    const q = String(query || "").trim().slice(0, 100);
    if (q.length < 2) return [];
    return api[provider].search(account, q);
  }

  // Update one or more platforms at once. `updates` = { twitch:{ title, categoryId }, kick:{...} }.
  // Each platform succeeds or fails on its own.
  async function update(account, updates = {}) {
    const results = {};
    for (const [provider, change] of Object.entries(updates || {})) {
      if (!PROVIDERS[provider]) { results[provider] = { ok:false, error:"unknown platform" }; continue; }
      if (!connections(account)[provider]) { results[provider] = { ok:false, error:`${PROVIDERS[provider].label} is not connected`, code:"NOT_CONNECTED" }; continue; }
      const next = {};
      if (change?.title !== undefined) {
        const title = String(change.title).replace(/[\r\n]+/g, " ").trim();
        if (!title) { results[provider] = { ok:false, error:"the title cannot be empty" }; continue; }
        next.title = title.slice(0, TITLE_MAX[provider]);
      }
      if (change?.categoryId !== undefined) {
        const id = String(change.categoryId || "").trim();
        if (id && !/^\d{1,20}$/.test(id)) { results[provider] = { ok:false, error:"invalid category" }; continue; }
        next.categoryId = id;
      }
      try { await api[provider].update(account, next); results[provider] = { ok:true, ...(next.title !== undefined && next.title.length < String(change.title).trim().length ? { truncated:true } : {}) }; }
      catch (err) { results[provider] = { ok:false, error:err.message, code:err.code }; }
    }
    return results;
  }

  return { PROVIDERS, status, current, searchCategories, update, storeConnection, disconnect, refresh };
}

module.exports = { createChannelInfoService, ChannelInfoError, PROVIDERS, TITLE_MAX };
