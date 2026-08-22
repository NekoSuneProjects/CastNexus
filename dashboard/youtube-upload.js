"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

function dailyKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function parseAllowlist(value = process.env.YOUTUBE_UPLOAD_ALLOWLIST || "") {
  return new Set(String(value).split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
}

function quotaAllowed(account, allowlist = parseAllowlist()) {
  if (!allowlist.size || allowlist.has("*")) return true;
  return allowlist.has(String(account?.twitchUserId || "").toLowerCase()) || allowlist.has(String(account?.twitchLogin || "").toLowerCase());
}

function encryptSecret(value, secret) {
  if (!value) return null;
  const key = crypto.createHash("sha256").update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return { v:1, iv:iv.toString("base64"), tag:cipher.getAuthTag().toString("base64"), data:data.toString("base64") };
}

function decryptSecret(blob, secret) {
  if (!blob?.iv || !blob?.tag || !blob?.data) return null;
  const key = crypto.createHash("sha256").update(String(secret)).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]).toString("utf8");
}

function createYoutubeUploadService({ clientId, clientSecret, redirectUri, state, saveState, recordings, hostedOauth = null, fetchImpl = global.fetch } = {}) {
  const tokenCache = new Map();
  const softLimit = Math.max(1, Number(process.env.YOUTUBE_UPLOAD_DAILY_SOFT_LIMIT || 90));
  const allowlist = parseAllowlist();

  function configured() { return !!(hostedOauth?.enabled?.() || (clientId && clientSecret && redirectUri)); }

  function quotaStatus(account) {
    const today = dailyKey();
    const q = account.youtubeUploadQuota || {};
    const used = q.date === today ? Number(q.attempts || 0) : 0;
    return { date:today, softLimit, used, remaining:Math.max(0, softLimit - used), allowed:quotaAllowed(account, allowlist) };
  }

  function countAttempt(account) {
    const today = dailyKey();
    if (!account.youtubeUploadQuota || account.youtubeUploadQuota.date !== today) account.youtubeUploadQuota = { date:today, attempts:0 };
    account.youtubeUploadQuota.attempts = Number(account.youtubeUploadQuota.attempts || 0) + 1;
    saveState(state);
  }

  function assertQuota(account) {
    const q = quotaStatus(account);
    if (!q.allowed) throw Object.assign(new Error("This CastNexus account is not on the YouTube upload quota whitelist."), { code:"YOUTUBE_NOT_WHITELISTED" });
    if (q.remaining <= 0) throw Object.assign(new Error(`CastNexus's local YouTube upload soft limit (${q.softLimit}/day) has been reached. This guard leaves headroom under the Google API project's upload quota.`), { code:"YOUTUBE_SOFT_QUOTA" });
  }

  function storeTokens(account, tokens) {
    const old = account.youtubeAuth || {};
    const refresh = tokens.refresh_token || (old.refreshToken ? decryptSecret(old.refreshToken, state.sessionSecret) : null);
    account.youtubeAuth = {
      connectedAt: old.connectedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      refreshToken: refresh ? encryptSecret(refresh, state.sessionSecret) : old.refreshToken || null,
      scope: tokens.scope || old.scope || "https://www.googleapis.com/auth/youtube.upload",
    };
    if (tokens.access_token) {
      tokenCache.set(account.twitchUserId, { token:tokens.access_token, expiresAt:Date.now() + Number(tokens.expires_in || 3600) * 1000 });
    }
    saveState(state);
  }

  function disconnect(account) {
    delete account.youtubeAuth;
    tokenCache.delete(account.twitchUserId);
    saveState(state);
  }

  async function exchangeCode(code) {
    if (hostedOauth?.enabled?.()) {
      const data = await hostedOauth.youtubeRefresh(refresh);
      if (!data.access_token) throw new Error("OAuth broker did not return a YouTube access token");
      tokenCache.set(account.twitchUserId, { token:data.access_token, expiresAt:Date.now() + Number(data.expires_in || 3600) * 1000 });
      return data.access_token;
    }
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body:new URLSearchParams({ client_id:clientId, client_secret:clientSecret, code, grant_type:"authorization_code", redirect_uri:redirectUri }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `Google token exchange failed (${res.status})`);
    return data;
  }

  async function accessToken(account) {
    const cached = tokenCache.get(account.twitchUserId);
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    const refresh = decryptSecret(account.youtubeAuth?.refreshToken, state.sessionSecret);
    if (!refresh) throw Object.assign(new Error("Connect YouTube before uploading recordings."), { code:"YOUTUBE_NOT_CONNECTED" });
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body:new URLSearchParams({ client_id:clientId, client_secret:clientSecret, refresh_token:refresh, grant_type:"refresh_token" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `Google token refresh failed (${res.status})`);
    tokenCache.set(account.twitchUserId, { token:data.access_token, expiresAt:Date.now() + Number(data.expires_in || 3600) * 1000 });
    return data.access_token;
  }

  async function downloadRecording(account, start, duration) {
    const sourceUrl = recordings.playbackUrl(account, start, duration, "mp4");
    const res = await fetchImpl(sourceUrl);
    if (!res.ok || !res.body) throw new Error(`MediaMTX playback download failed (${res.status})`);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "castnexus-youtube-"));
    const filePath = path.join(tempDir, "recording.mp4");
    const nodeBody = typeof Readable.fromWeb === "function" ? Readable.fromWeb(res.body) : res.body;
    await pipeline(nodeBody, fs.createWriteStream(filePath));
    return { filePath, tempDir };
  }

  async function initiateResumable(account, filePath, metadata) {
    assertQuota(account);
    const token = await accessToken(account);
    const stat = await fs.promises.stat(filePath);
    const privacyStatus = ["private", "unlisted", "public"].includes(metadata.privacyStatus) ? metadata.privacyStatus : "private";
    const body = {
      snippet: {
        title: String(metadata.title || "CastNexus recording").slice(0, 100),
        description: String(metadata.description || "").slice(0, 5000),
        categoryId: String(metadata.categoryId || "20"),
        tags: Array.isArray(metadata.tags) ? metadata.tags.map(String).slice(0, 30) : [],
      },
      status: { privacyStatus, selfDeclaredMadeForKids:false },
    };
    countAttempt(account);
    const url = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
    const res = await fetchImpl(url, {
      method:"POST",
      headers:{
        "Authorization":`Bearer ${token}`,
        "Content-Type":"application/json; charset=UTF-8",
        "X-Upload-Content-Length":String(stat.size),
        "X-Upload-Content-Type":"video/mp4",
      },
      body:JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`YouTube upload session failed (${res.status}): ${text.slice(0, 600)}`);
    const location = res.headers.get("location");
    if (!location) throw new Error("YouTube did not return a resumable upload URL");
    return { location, size:stat.size, token };
  }

  async function uploadFile(account, filePath, metadata) {
    const session = await initiateResumable(account, filePath, metadata);
    const res = await fetchImpl(session.location, {
      method:"PUT",
      headers:{ "Authorization":`Bearer ${session.token}`, "Content-Type":"video/mp4", "Content-Length":String(session.size) },
      body:fs.createReadStream(filePath),
      duplex:"half",
    });
    const data = await res.json().catch(async () => ({ raw:await res.text().catch(() => "") }));
    if (!res.ok) throw new Error(data?.error?.message || `YouTube video upload failed (${res.status})`);
    return { id:data.id, url:data.id ? `https://www.youtube.com/watch?v=${data.id}` : null, privacyStatus:data.status?.privacyStatus || metadata.privacyStatus || "private", response:data };
  }

  async function uploadRecording(account, recording, metadata) {
    if (!configured()) throw new Error("YouTube OAuth is not configured on this CastNexus instance");
    const temp = await downloadRecording(account, recording.start, recording.duration);
    try { return await uploadFile(account, temp.filePath, metadata); }
    finally { fs.rm(temp.tempDir, { recursive:true, force:true }, () => {}); }
  }

  function status(account) {
    return {
      configured:configured(),
      connected:!!account.youtubeAuth?.refreshToken,
      connectedAt:account.youtubeAuth?.connectedAt || null,
      quota:quotaStatus(account),
      redirectUri,
    };
  }

  return { configured, quotaStatus, assertQuota, storeTokens, disconnect, exchangeCode, accessToken, uploadFile, uploadRecording, status };
}

module.exports = { createYoutubeUploadService, parseAllowlist, quotaAllowed, encryptSecret, decryptSecret, dailyKey };
