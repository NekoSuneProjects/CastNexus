"use strict";

function parseTwitchDuration(value) {
  const text = String(value || "");
  const h = Number((text.match(/(\d+)h/) || [])[1] || 0);
  const m = Number((text.match(/(\d+)m/) || [])[1] || 0);
  const s = Number((text.match(/(\d+)s/) || [])[1] || 0);
  return h * 3600 + m * 60 + s;
}

function createTwitchApi({ clientId, clientSecret, hostedOauth = null, fetchImpl = global.fetch } = {}) {
  let token = null;
  let tokenExpiresAt = 0;

  async function appToken() {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    if (!clientId || !clientSecret) throw new Error("Twitch API credentials are not configured");
    const url = new URL("https://id.twitch.tv/oauth2/token");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("client_secret", clientSecret);
    url.searchParams.set("grant_type", "client_credentials");
    const res = await fetchImpl(url, { method:"POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(data.message || `Twitch token request failed (${res.status})`);
    token = data.access_token;
    tokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    return token;
  }

  async function helix(pathname, params = {}, brokerToken = "") {
    if (hostedOauth?.enabled?.()) return hostedOauth.twitchHelix(pathname.replace(/^\//, ""), params, brokerToken);
    const accessToken = await appToken();
    const url = new URL(`https://api.twitch.tv/helix/${pathname.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, String(v)));
      else url.searchParams.set(key, String(value));
    }
    const res = await fetchImpl(url, {
      headers: { "Client-Id": clientId, "Authorization": `Bearer ${accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Twitch API request failed (${res.status})`);
    return data;
  }

  async function getStream({ userId, login, brokerToken } = {}) {
    const data = await helix("streams", userId ? { user_id:userId } : { user_login:login }, brokerToken);
    return data.data?.[0] || null;
  }

  async function isLive({ userId, login, brokerToken } = {}) {
    const stream = await getStream({ userId, login, brokerToken });
    return {
      live: !!stream,
      stream: stream ? {
        id: stream.id,
        userId: stream.user_id,
        userLogin: stream.user_login,
        userName: stream.user_name,
        gameId: stream.game_id,
        gameName: stream.game_name,
        title: stream.title,
        viewerCount: stream.viewer_count,
        startedAt: stream.started_at,
        language: stream.language,
        thumbnailUrl: stream.thumbnail_url,
      } : null,
    };
  }

  async function getVideos(userId, { first = 100, type = "archive", brokerToken = "" } = {}) {
    if (!userId) throw new Error("Twitch user id is required");
    const data = await helix("videos", { user_id:userId, first:Math.min(100, Math.max(1, Number(first) || 100)), type }, brokerToken);
    return (data.data || []).map(video => ({
      id: video.id,
      streamId: video.stream_id || null,
      userId: video.user_id,
      userLogin: video.user_login,
      userName: video.user_name,
      title: video.title || "Twitch VOD",
      description: video.description || "",
      createdAt: video.created_at,
      publishedAt: video.published_at,
      url: video.url || `https://www.twitch.tv/videos/${video.id}`,
      thumbnail: video.thumbnail_url || "",
      viewable: video.viewable,
      viewCount: video.view_count,
      language: video.language,
      type: video.type,
      duration: video.duration,
      durationS: parseTwitchDuration(video.duration),
      mutedSegments: video.muted_segments || null,
    }));
  }

  return { appToken, helix, getStream, isLive, getVideos };
}

module.exports = { createTwitchApi, parseTwitchDuration };
