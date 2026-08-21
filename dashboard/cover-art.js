"use strict";

const DEFAULT_PROVIDERS = ["musicbrainz", "itunes"];
const DEFAULT_TIMEOUT_MS = Number(process.env.COVER_LOOKUP_TIMEOUT_MS || 5000);
const DEFAULT_CACHE_HOURS = Number(process.env.COVER_LOOKUP_CACHE_HOURS || 168);
const MUSICBRAINZ_USER_AGENT = process.env.COVER_MUSICBRAINZ_USER_AGENT || "CastNexus/1.0 (https://github.com/NekoSuneProjects/CastNexus)";

function normalise(value) {
  return String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function upgradeItunesArtwork(value) {
  const url = safeHttpsUrl(value);
  if (!url) return null;
  return url.replace(/\/\d+x\d+bb\./i, "/600x600bb.");
}

function scoreMatch(track, candidateTitle, candidateArtist, candidateAlbum = "") {
  const wantedTitle = normalise(track.title);
  const wantedArtist = normalise(track.artist);
  const wantedAlbum = normalise(track.album);
  const gotTitle = normalise(candidateTitle);
  const gotArtist = normalise(candidateArtist);
  const gotAlbum = normalise(candidateAlbum);
  let score = 0;
  if (wantedTitle && gotTitle === wantedTitle) score += 8;
  else if (wantedTitle && (gotTitle.includes(wantedTitle) || wantedTitle.includes(gotTitle))) score += 4;
  if (wantedArtist && gotArtist === wantedArtist) score += 6;
  else if (wantedArtist && (gotArtist.includes(wantedArtist) || wantedArtist.includes(gotArtist))) score += 3;
  if (wantedAlbum && gotAlbum === wantedAlbum) score += 3;
  return score;
}

function pickItunesResult(track, results) {
  const candidates = Array.isArray(results) ? results : [];
  return candidates
    .filter(item => item && (item.kind === "song" || item.wrapperType === "track") && item.artworkUrl100)
    .map(item => ({ item, score: scoreMatch(track, item.trackName, item.artistName, item.collectionName) }))
    .sort((a, b) => b.score - a.score)[0]?.item || null;
}

function pickMusicBrainzRelease(track, recordings) {
  const rows = Array.isArray(recordings) ? recordings : [];
  const ranked = [];
  for (const recording of rows) {
    const artist = Array.isArray(recording?.["artist-credit"])
      ? recording["artist-credit"].map(part => part?.name || part?.artist?.name || "").filter(Boolean).join(" ")
      : "";
    const score = scoreMatch(track, recording?.title, artist, "");
    for (const release of recording?.releases || []) {
      if (release?.id) ranked.push({ release, score: score + (normalise(track.album) && normalise(release.title) === normalise(track.album) ? 3 : 0) });
    }
  }
  return ranked.sort((a, b) => b.score - a.score).map(item => item.release);
}

function coverFromCaaPayload(payload) {
  const images = Array.isArray(payload?.images) ? payload.images : [];
  const image = images.find(item => item?.front) || images[0];
  if (!image) return null;
  const thumbs = image.thumbnails || {};
  return safeHttpsUrl(thumbs["1200"] || thumbs.large || thumbs["500"] || image.image);
}

function createCoverArtResolver({ fetchImpl = global.fetch, providers = null } = {}) {
  const configured = providers || String(process.env.COVER_LOOKUP_PROVIDERS || DEFAULT_PROVIDERS.join(","))
    .split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  const cache = new Map();
  let musicBrainzReadyAt = 0;

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitMusicBrainzSlot() {
    const now = Date.now();
    const wait = Math.max(0, musicBrainzReadyAt - now);
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    musicBrainzReadyAt = Date.now() + 1100;
  }

  async function fromMusicBrainz(track) {
    if (!track.title) return null;
    const parts = [`recording:${JSON.stringify(String(track.title))}`];
    if (track.artist) parts.push(`artist:${JSON.stringify(String(track.artist))}`);
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(parts.join(" AND "))}&fmt=json&limit=5`;
    await waitMusicBrainzSlot();
    const payload = await fetchJson(url, { headers: { "User-Agent": MUSICBRAINZ_USER_AGENT, Accept: "application/json" } });
    const releases = pickMusicBrainzRelease(track, payload?.recordings);
    for (const release of releases.slice(0, 3)) {
      const caa = await fetchJson(`https://coverartarchive.org/release/${encodeURIComponent(release.id)}`, { headers: { Accept: "application/json" } });
      const cover = coverFromCaaPayload(caa);
      if (cover) return { url: cover, provider: "musicbrainz", releaseId: release.id };
    }
    return null;
  }

  async function fromItunes(track) {
    if (!track.title) return null;
    const term = [track.title, track.artist].filter(Boolean).join(" ");
    const country = String(process.env.COVER_ITUNES_COUNTRY || "US").slice(0, 2).toUpperCase();
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${encodeURIComponent(country)}&media=music&entity=song&limit=5`;
    const payload = await fetchJson(url, { headers: { Accept: "application/json" } });
    const match = pickItunesResult(track, payload?.results);
    const cover = upgradeItunesArtwork(match?.artworkUrl100);
    return cover ? { url: cover, provider: "itunes", storeUrl: safeHttpsUrl(match?.trackViewUrl || match?.collectionViewUrl) } : null;
  }

  const providerMap = { musicbrainz: fromMusicBrainz, itunes: fromItunes };

  async function lookup(track) {
    const key = [normalise(track?.title), normalise(track?.artist), normalise(track?.album)].join("|");
    if (!key.replace(/\|/g, "")) return null;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let result = null;
    for (const provider of configured) {
      const fn = providerMap[provider];
      if (!fn) continue;
      try {
        result = await fn(track || {});
      } catch {
        result = null;
      }
      if (result?.url) break;
    }

    const hours = result ? DEFAULT_CACHE_HOURS : Math.min(DEFAULT_CACHE_HOURS, 12);
    cache.set(key, { value: result, expiresAt: Date.now() + Math.max(1, hours) * 3600 * 1000 });
    return result;
  }

  return { lookup, providers: configured };
}

module.exports = {
  createCoverArtResolver,
  normalise,
  safeHttpsUrl,
  upgradeItunesArtwork,
  scoreMatch,
  pickItunesResult,
  pickMusicBrainzRelease,
  coverFromCaaPayload,
};
