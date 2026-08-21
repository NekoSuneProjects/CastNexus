"use strict";

const fs = require("node:fs");
const path = require("node:path");

function safeRecordingPath(account) {
  const login = String(account?.twitchLogin || account?.twitchUserId || "unknown").replace(/[^A-Za-z0-9_-]/g, "-");
  return `public/${login}`;
}

function dirSizeSync(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes:true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  }
  return total;
}

function createMediaMtxRecordings({
  apiBase = process.env.MEDIAMTX_API || "http://127.0.0.1:9997",
  playbackBase = process.env.MEDIAMTX_PLAYBACK || "http://127.0.0.1:9996",
  recordingsDir = process.env.RECORDINGS_DIR || "/recordings",
  state,
  saveState,
} = {}) {
  async function request(url, options = {}) {
    const res = await fetch(url, options);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const err = new Error(data?.error || data?.message || (typeof data === "string" && data) || `MediaMTX request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function localDir(account) {
    return path.join(recordingsDir, ...safeRecordingPath(account).split("/"));
  }

  async function ensureConfig(account, enabled = !!account.recordingEnabled) {
    const name = safeRecordingPath(account);
    const encoded = encodeURIComponent(name);
    const body = JSON.stringify({ record:Boolean(enabled) });
    const headers = { "Content-Type":"application/json" };
    try {
      await request(`${apiBase}/v3/config/paths/get/${encoded}`);
      await request(`${apiBase}/v3/config/paths/patch/${encoded}`, { method:"PATCH", headers, body });
    } catch (err) {
      if (err.status !== 404) throw err;
      await request(`${apiBase}/v3/config/paths/add/${encoded}`, { method:"POST", headers, body });
    }
    return { path:name, enabled:Boolean(enabled) };
  }

  async function setEnabled(account, enabled) {
    account.recordingEnabled = Boolean(enabled);
    if (state && saveState) saveState(state);
    await ensureConfig(account, account.recordingEnabled);
    return account.recordingEnabled;
  }

  async function playbackSegments(account) {
    const name = safeRecordingPath(account);
    const url = new URL(`${playbackBase}/list`);
    url.searchParams.set("path", name);
    try {
      const data = await request(url);
      return Array.isArray(data) ? data.map(segment => ({
        start: segment.start,
        duration: Number(segment.duration || 0),
        path: name,
      })) : [];
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  async function controlSegments(account) {
    const name = safeRecordingPath(account);
    try {
      const data = await request(`${apiBase}/v3/recordings/get/${encodeURIComponent(name)}`);
      return Array.isArray(data?.segments) ? data.segments : [];
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  async function list(account) {
    const [playback, control] = await Promise.all([playbackSegments(account), controlSegments(account)]);
    const durationByStart = new Map(playback.map(x => [x.start, x.duration]));
    const starts = control.length ? control.map(x => x.start) : playback.map(x => x.start);
    const segments = starts.filter(Boolean).map(start => ({
      start,
      duration: Number(durationByStart.get(start) || 0),
      path: safeRecordingPath(account),
    })).sort((a,b) => String(b.start).localeCompare(String(a.start)));
    return {
      enabled: !!account.recordingEnabled,
      path: safeRecordingPath(account),
      bytes: dirSizeSync(localDir(account)),
      segmentCount: segments.length,
      segments,
    };
  }

  async function deleteSegment(account, start) {
    if (!start) throw new Error("recording start time is required");
    const url = new URL(`${apiBase}/v3/recordings/deletesegment`);
    url.searchParams.set("path", safeRecordingPath(account));
    url.searchParams.set("start", String(start));
    await request(url, { method:"DELETE" });
    return list(account);
  }

  async function deleteAll(account) {
    const segments = await controlSegments(account);
    for (const segment of segments) {
      if (!segment.start) continue;
      try { await deleteSegment(account, segment.start); } catch (err) { console.warn(`[recordings] delete ${segment.start}: ${err.message}`); }
    }
    return list(account);
  }

  function playbackUrl(account, start, duration, format = "mp4") {
    const url = new URL(`${playbackBase}/get`);
    url.searchParams.set("path", safeRecordingPath(account));
    url.searchParams.set("start", String(start));
    if (Number(duration) > 0) url.searchParams.set("duration", String(duration));
    url.searchParams.set("format", format);
    return url.toString();
  }

  return { safeRecordingPath, localDir, ensureConfig, setEnabled, list, deleteSegment, deleteAll, playbackUrl, request, playbackBase, recordingsDir };
}

module.exports = { createMediaMtxRecordings, safeRecordingPath, dirSizeSync };
