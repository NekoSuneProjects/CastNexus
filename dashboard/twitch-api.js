"use strict";

function parseTwitchDuration(value) {
  const text = String(value || "");
  const h = Number((text.match(/(\d+)h/) || [])[1] || 0);
  const m = Number((text.match(/(\d+)m/) || [])[1] || 0);
  const s = Number((text.match(/(\d+)s/) || [])[1] || 0);
  return h * 3600 + m * 60 + s;
}

function createTwitchApi({ hostedOauth } = {}) {
  if (!hostedOauth) throw new Error("createTwitchApi requires a hostedOauth client");

  async function helix(pathname, params = {}, brokerToken = "") {
    return hostedOauth.twitchHelix(pathname.replace(/^\//, ""), params, brokerToken);
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

  return { helix, getStream, isLive, getVideos };
}

module.exports = { createTwitchApi, parseTwitchDuration };
