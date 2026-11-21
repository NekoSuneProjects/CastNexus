"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const express = require("express");
const multer = require("multer");
const { safeSegment, profileById, activeProfileFor } = require("./profile-music");
const { detectEncoder, globalEncoderArgs, videoEncoderArgs } = require("./gpu-encoder");
const { cpuX264Tuning, liveInputArgs, liveMuxArgs, stableAudioArgs } = require("./rtmp-pipeline");
const { profilePublishPath, RELAY_APP } = require("./profile-rtmp");

const REMOTE_KINDS = new Set(["youtube", "twitch-vod"]);
const VIDEO_MIME_PREFIXES = ["video/"];
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const TWITCH_CATALOG_TTL_MS = Number(process.env.TWITCH_VOD_REFRESH_MS || 5 * 60 * 1000);

function defaultBucket() {
  return { items: [], createdAt: new Date().toISOString() };
}

function isAllowedYouTubeHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "youtu.be" || h === "youtube.com" || h === "www.youtube.com" || h === "m.youtube.com" || h.endsWith(".youtube.com");
}

function isAllowedTwitchHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "twitch.tv" || h === "www.twitch.tv" || h === "m.twitch.tv" || h.endsWith(".twitch.tv");
}

function normalizeRemoteUrl(kind, raw) {
  const value = String(raw || "").trim();
  if (kind === "twitch-live" && /^[A-Za-z0-9_]{2,32}$/.test(value)) return `https://www.twitch.tv/${value}`;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (kind === "youtube" && !isAllowedYouTubeHost(url.hostname)) return null;
  if ((kind === "twitch-vod" || kind === "twitch-live") && !isAllowedTwitchHost(url.hostname)) return null;
  if (kind === "twitch-live" && /\/videos\//i.test(url.pathname)) return null;
  return url.toString();
}

function isYouTubeChallenge(text) {
  return /sign in to confirm|not a bot|confirm you.?re not a bot|cookies? (?:from|are|required)|login required|authentication required|HTTP Error 403|403 Forbidden/i.test(String(text || ""));
}

function friendlyResolverError(kind, stderr, fallback) {
  if (kind === "youtube" && isYouTubeChallenge(stderr)) {
    const err = new Error("YouTube blocked this network/session. CastNexus does not request browser cookies. Try from a home/residential connection, or upload the video manually to the VOD library.");
    err.code = "YOUTUBE_CHALLENGE";
    return err;
  }
  const cleaned = String(stderr || "").split(/\r?\n/).filter(Boolean).slice(-4).join(" · ");
  return new Error(cleaned || fallback || "media resolver failed");
}

function capture(bin, args, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", chunk => { if (stdout.length < CAPTURE_LIMIT) stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { if (stderr.length < CAPTURE_LIMIT) stderr += chunk.toString(); });
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => {
      clearTimeout(timer);
      if (killed) return reject(Object.assign(new Error(`${bin} timed out`), { stderr }));
      if (code !== 0) return reject(Object.assign(new Error(`${bin} exited with code ${code}`), { stderr, stdout, code }));
      resolve({ stdout, stderr });
    });
  });
}

function ytDlpBase(kind) {
  const args = ["--no-warnings", "--no-playlist", "--no-cookies"];
  if (kind === "youtube") args.push("--js-runtimes", "deno", "--remote-components", "ejs:npm");
  return args;
}

function remoteFormatFor(kind) {
  if (kind === "youtube") return "bestvideo[height<=1080]+bestaudio/best[height<=1080]";
  if (kind === "twitch-live" || kind === "twitch-vod") return "best[acodec!=none][vcodec!=none]/best";
  return "best";
}

async function inspectRemote(kind, url) {
  try {
    const { stdout } = await capture(YTDLP_BIN, [...ytDlpBase(kind), "--dump-single-json", "--skip-download", url], { timeoutMs: 60_000 });
    const info = JSON.parse(stdout);
    return {
      title: String(info.title || info.fulltitle || "Remote VOD").slice(0, 240),
      durationS: Number.isFinite(Number(info.duration)) ? Number(info.duration) : null,
      uploader: String(info.uploader || info.channel || info.creator || "").slice(0, 160),
      thumbnail: typeof info.thumbnail === "string" ? info.thumbnail : "",
      webpageUrl: String(info.webpage_url || url),
    };
  } catch (err) {
    throw friendlyResolverError(kind, err.stderr, err.message);
  }
}

async function resolveRemote(kind, url) {
  try {
    const { stdout } = await capture(YTDLP_BIN, [...ytDlpBase(kind), "-g", "-f", remoteFormatFor(kind), url], { timeoutMs: 60_000 });
    const urls = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!urls.length) throw new Error("resolver returned no playable URL");
    return urls.slice(0, 2);
  } catch (err) {
    throw friendlyResolverError(kind, err.stderr, err.message);
  }
}

// Twitch live HLS is stream-copied (cheap, and it must keep up with the live
// edge). Twitch VODs used to be copied too, but Twitch archives are H.264
// High profile with B-frames: MediaMTX's WebRTC player (the Studio preview /
// public web player) cannot decode B-frames, so a Twitch VOD rerun showed a
// black preview with no sound even though FFmpeg was relaying fine. VODs are
// now re-encoded like uploads (zero-latency, no B-frames). Set
// VOD_TWITCH_VOD_COPY=true to go back to copying.
function copiesVideo(kind) {
  if (kind === "twitch-live") return String(process.env.VOD_TWITCH_LIVE_COPY || "true").toLowerCase() !== "false";
  if (kind === "twitch-vod") return String(process.env.VOD_TWITCH_VOD_COPY || "false").toLowerCase() === "true";
  return false;
}

function ffmpegArgsFor(source, outputUrl, options = {}) {
  const selected = options.forceCpu ? { id:"libx264", encoder:"libx264", hardware:false, label:"CPU · x264" } : detectEncoder();
  const isLive = source.kind === "twitch-live";
  // Remote HLS (Twitch) inputs need the live/HLS input options; local files do not.
  const isHls = source.kind === "twitch-live" || source.kind === "twitch-vod";
  const copy = copiesVideo(source.kind);
  const inputs = source.inputs || [];
  const args = ["-hide_banner", "-loglevel", "warning", "-nostats"];
  if (!copy) args.push(...globalEncoderArgs(selected));

  for (const input of inputs) {
    if (!isLive) args.push("-re");
    if (isHls) args.push(...liveInputArgs());
    args.push("-i", input);
  }

  args.push("-map", "0:v:0");
  if (inputs.length > 1) args.push("-map", isHls ? "1:a:0" : "1:a:0?");
  else args.push("-map", isHls ? "0:a:0" : "0:a:0?");

  // Copied Twitch video keeps the source frames, but audio is always decoded
  // and rebuilt as a continuous AAC stereo stream before MediaMTX sees it.
  // Some Twitch HLS relays looked fine on video while copied audio
  // disappeared or arrived with unusable timestamps at downstream ingest.
  if (copy) {
    args.push(
      "-c:v", "copy",
      ...stableAudioArgs({
        bitrate:process.env.VOD_RELAY_AUDIO_BITRATE || "160k",
        sampleRate:process.env.VOD_RELAY_AUDIO_RATE || "48000",
      })
    );
  } else {
    const fps = Number(process.env.VOD_FPS || 30);
    let vf = "scale=1920:1080:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";
    if (selected.id === "vaapi") vf += ",format=nv12,hwupload";
    else vf += ",format=yuv420p";
    const tuned = cpuX264Tuning({ hardwareEncoder:selected.hardware, width:1920, height:1080, fps, kind:"transcode" });
    args.push(
      "-vf", vf,
      "-r", String(fps),
      ...videoEncoderArgs(selected, {
        fps,
        bitrate:process.env.VOD_VIDEO_BITRATE || "6000k",
        maxrate:process.env.VOD_VIDEO_MAXRATE || "6500k",
        bufsize:process.env.VOD_VIDEO_BUFSIZE || "12000k",
        // Measured CPU-only hosts get a preset that fits; otherwise veryfast.
        x264Preset:process.env.VOD_X264_PRESET || (tuned.auto ? tuned.preset : "veryfast"),
        x264Threads:tuned.threads,
      }),
      ...(isHls
        ? stableAudioArgs({ bitrate:process.env.VOD_AUDIO_BITRATE || "160k", sampleRate:"48000" })
        : ["-c:a", "aac", "-b:a", process.env.VOD_AUDIO_BITRATE || "160k", "-ar", "48000", "-ac", "2"])
    );
  }

  args.push(...liveMuxArgs(outputUrl, "flv"), outputUrl);
  return args;
}

function createProfileVodService({ state, saveState, vodDir, maxBytes, probeDurationSeconds, rtmpOrigin = "rtmp://127.0.0.1:1935", twitchApi = null, allowCustomDownloadDir = false }) {
  const sessions = new Map();

  function ensureCollections(account) {
    if (!account.vodProfiles || typeof account.vodProfiles !== "object" || Array.isArray(account.vodProfiles)) {
      account.vodProfiles = {};
      saveState(state);
    }
  }

  function resolveProfile(account, profileId) {
    return profileById(account, profileId) || (!profileId ? activeProfileFor(account) : null);
  }

  function bucketFor(account, profileId, create = true) {
    ensureCollections(account);
    const profile = resolveProfile(account, profileId);
    if (!profile) return null;
    const id = safeSegment(profile.id);
    let bucket = account.vodProfiles[id];
    if (!bucket && create) {
      bucket = defaultBucket();
      account.vodProfiles[id] = bucket;
      saveState(state);
    }
    if (!bucket) return { profile, profileId:id, bucket:null, items:[] };
    if (!Array.isArray(bucket.items)) bucket.items = [];
    return { profile, profileId:id, bucket, items:bucket.items };
  }

  function diskDir(account, profileId) {
    return path.join(vodDir, safeSegment(account.twitchUserId), safeSegment(profileId));
  }

  function uploadedFilePath(account, info, item) {
    return item?.kind === "upload" && item.filename ? path.join(diskDir(account, info.profileId), item.filename) : null;
  }

  function publicStatus(accountId) {
    const session = sessions.get(accountId);
    if (!session) return { state:"idle" };
    return {
      state:session.state,
      profileId:session.profileId,
      itemId:session.itemId || null,
      kind:session.kind,
      title:session.title,
      loop:!!session.loop,
      shuffle:!!session.queue?.shuffle,
      queue:session.queue ? { index:session.queue.index, length:session.queue.ids.length, ids:session.queue.ids } : null,
      local:!!session.local,
      startedAt:session.startedAt,
      error:session.error || null,
      encoder:session.encoder || null,
      relayPath:session.relayPath || null,
    };
  }

  async function stop(accountId) {
    const session = sessions.get(accountId);
    if (!session) return;
    session.manualStop = true;
    session.state = "stopping";
    if (session.child) {
      session.child.removeAllListeners("close");
      try { session.child.kill("SIGTERM"); } catch {}
    }
    sessions.delete(accountId);
  }

  // ------------------------------------------------ optional local copies
  // Remote VODs (YouTube / Twitch) normally stream straight from the site.
  // A user can also download one: playback then prefers the local file and
  // falls back to the website if the file is gone.
  function downloadDirFor(account, info) {
    const custom = allowCustomDownloadDir ? String(account.vodSettings?.downloadDir || "").trim() : "";
    return custom ? path.join(custom, safeSegment(info.profileId)) : path.join(diskDir(account, info.profileId), "downloads");
  }

  function localFileFor(item) {
    const file = item?.download?.file;
    return file && item.download.state === "done" && fs.existsSync(file) ? file : null;
  }

  function preferLocal(account) {
    return account.vodSettings?.preferLocal !== false;
  }

  async function sourceForItem(account, info, item) {
    if (item.kind === "upload") {
      const filePath = uploadedFilePath(account, info, item);
      if (!filePath || !fs.existsSync(filePath)) throw new Error("uploaded VOD file is missing");
      return { kind:"upload", inputs:[filePath] };
    }
    if (item.kind === "youtube" || item.kind === "twitch-vod") {
      const local = preferLocal(account) ? localFileFor(item) : null;
      if (local) return { kind:"file", inputs:[local], local:true };
      return { kind:item.kind, inputs:await resolveRemote(item.kind, item.url) };
    }
    throw new Error("unsupported VOD source");
  }

  function shuffled(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }

  function encoderLabelFor(source) {
    return copiesVideo(source.kind) ? { label:"Video copy · AAC audio", hardware:false } : detectEncoder();
  }

  // One running rerun per account. meta.queue = { ids, index, shuffle, loop }
  // plays a playlist: each item is resolved when its turn comes.
  async function startResolved(account, info, source, meta) {
    await stop(account.twitchUserId);
    const relayPath = profilePublishPath(info.profile, RELAY_APP);
    if (!relayPath) throw new Error("profile RTMP key is unavailable; reload the profile and try again");
    const outputUrl = `${rtmpOrigin}/${relayPath}`;
    let current = source;
    let encoder = encoderLabelFor(current);
    const session = {
      state:"starting",
      profileId:info.profile.id,
      itemId:meta.itemId || null,
      kind:current.kind,
      title:meta.title || "Rerun",
      loop:!!meta.loop,
      queue:meta.queue || null,
      local:!!current.local,
      startedAt:new Date().toISOString(),
      error:null,
      encoder:encoder.label,
      relayPath,
      child:null,
      manualStop:false,
      forceCpu:false,
      failures:0,
    };
    sessions.set(account.twitchUserId, session);
    const alive = () => !session.manualStop && sessions.get(account.twitchUserId) === session;

    // Next playlist entry; skips items that were deleted or fail to resolve.
    const advance = async () => {
      const q = session.queue;
      while (alive()) {
        q.index += 1;
        if (q.index >= q.ids.length) {
          if (!q.loop) { session.state = "completed"; return; }
          q.index = 0;
          if (q.shuffle) q.ids = shuffled(q.ids);
        }
        if (session.failures >= q.ids.length) { session.state = "error"; session.error = `every playlist item failed${session.error ? ` (last: ${session.error})` : ""}`; return; }
        const item = info.items.find(i => i.id === q.ids[q.index]);
        if (!item) { session.failures += 1; continue; }
        try {
          session.state = "restarting";
          current = await sourceForItem(account, info, item);
          if (!alive()) return;
          encoder = encoderLabelFor(current);
          Object.assign(session, { itemId:item.id, title:item.title, kind:current.kind, local:!!current.local, encoder:encoder.label, forceCpu:false });
          return launch();
        } catch (err) {
          session.failures += 1;
          session.error = `${item.title}: ${err.message}`;
        }
      }
    };

    const launch = () => {
      if (!alive()) return;
      session.state = "starting";
      const started = Date.now();
      const child = spawn(FFMPEG_BIN, ffmpegArgsFor(current, outputUrl, { forceCpu:session.forceCpu }), { stdio:["ignore", "ignore", "pipe"] });
      session.child = child;
      let stderrTail = "";
      child.stderr.on("data", chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-6000); });
      child.on("error", err => { session.error = err.message; session.state = "error"; });
      child.once("spawn", () => { session.state = "playing"; });
      child.once("close", code => {
        if (session.child === child) session.child = null;
        if (!alive()) return;
        const fastFailure = code !== 0 && Date.now() - started < 8000;
        if (fastFailure && encoder.hardware && !copiesVideo(current.kind) && !session.forceCpu) {
          session.forceCpu = true;
          session.encoder = "CPU · x264 fallback";
          session.state = "restarting";
          return setTimeout(launch, 500);
        }
        if (session.queue) {
          if (code === 0) session.failures = 0;
          else { session.failures += 1; session.error = stderrTail.split(/\r?\n/).filter(Boolean).slice(-3).join(" · ") || `FFmpeg exited with code ${code}`; }
          return setTimeout(() => { advance().catch(err => { session.state = "error"; session.error = err.message; }); }, 750);
        }
        if (code === 0 && session.loop && current.kind !== "twitch-live") {
          session.state = "restarting";
          return setTimeout(launch, 750);
        }
        session.state = code === 0 ? "completed" : "error";
        session.error = code === 0 ? null : (stderrTail.split(/\r?\n/).filter(Boolean).slice(-3).join(" · ") || `FFmpeg exited with code ${code}`);
      });
    };

    launch();
    return publicStatus(account.twitchUserId);
  }

  async function playItem(account, profileId, itemId, loop) {
    const info = bucketFor(account, profileId, false);
    if (!info) throw new Error("unknown profile");
    const item = info.items.find(i => i.id === itemId);
    if (!item) throw new Error("unknown VOD item in this profile");
    const source = await sourceForItem(account, info, item);
    return startResolved(account, info, source, { itemId:item.id, title:item.title, loop });
  }

  // ------------------------------------------------------------ playlist
  function playlistFor(info) {
    const ids = Array.isArray(info.bucket?.playlist) ? info.bucket.playlist : [];
    const known = new Set(info.items.map(i => i.id));
    return ids.filter(id => known.has(id));
  }

  function setPlaylist(account, profileId, itemIds) {
    const info = bucketFor(account, profileId);
    if (!info) throw Object.assign(new Error("unknown profile"), { status:404 });
    const known = new Set(info.items.map(i => i.id));
    const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(String))].filter(id => known.has(id)).slice(0, 500);
    info.bucket.playlist = ids;
    saveState(state);
    return ids;
  }

  // Adds a library item, or a Twitch cloud VOD (copied into the library
  // first), to the end of the playlist.
  async function addToPlaylist(account, profileId, { itemId = null, twitchVideoId = null } = {}) {
    const info = bucketFor(account, profileId);
    if (!info) throw Object.assign(new Error("unknown profile"), { status:404 });
    let item = itemId ? info.items.find(i => i.id === String(itemId)) : null;
    if (!item && twitchVideoId) {
      const catalog = await getTwitchCatalog(account);
      const video = (catalog.items || []).find(v => String(v.id) === String(twitchVideoId));
      if (!video) throw Object.assign(new Error("Twitch VOD was not found in your account catalog"), { status:404 });
      item = info.items.find(i => i.kind === "twitch-vod" && i.twitchVideoId === String(video.id));
      if (!item) {
        item = { id:crypto.randomUUID(), kind:"twitch-vod", twitchVideoId:String(video.id), title:video.title, uploader:video.userName || "", thumbnail:video.thumbnail || "", url:video.url, durationS:video.durationS ?? null, addedAt:new Date().toISOString() };
        info.items.push(item);
      }
    }
    if (!item) throw Object.assign(new Error("unknown VOD item in this profile"), { status:404 });
    const ids = playlistFor(info);
    ids.push(item.id);
    info.bucket.playlist = ids;
    saveState(state);
    return { playlist:ids, item };
  }

  async function playPlaylist(account, profileId, { shuffle = false, loop = false, startItemId = null } = {}) {
    const info = bucketFor(account, profileId, false);
    if (!info) throw new Error("unknown profile");
    // An empty playlist plays the whole library (e.g. "shuffle everything").
    let ids = playlistFor(info);
    if (!ids.length) ids = info.items.map(i => i.id);
    if (!ids.length) throw new Error("add some VODs to the library or playlist first");
    if (shuffle) ids = shuffled(ids);
    let index = startItemId ? Math.max(0, ids.indexOf(String(startItemId))) : 0;
    const queue = { ids, index, shuffle:!!shuffle, loop:!!loop };
    // Resolve the first playable entry; later ones are resolved on their turn.
    let lastError = null;
    for (let tries = 0; tries < ids.length; tries++, index = (index + 1) % ids.length) {
      const item = info.items.find(i => i.id === ids[index]);
      if (!item) continue;
      try {
        const source = await sourceForItem(account, info, item);
        queue.index = index;
        return startResolved(account, info, source, { itemId:item.id, title:item.title, loop:!!loop, queue });
      } catch (err) { lastError = err; }
    }
    throw lastError || new Error("no playable VOD in the playlist");
  }

  // ------------------------------------------------------------ downloads
  const downloads = new Map(); // `${accountId}:${itemId}` -> yt-dlp child

  function ffmpegLocation() {
    return path.isAbsolute(FFMPEG_BIN) ? path.dirname(FFMPEG_BIN) : null;
  }

  function startDownload(account, profileId, itemId) {
    const info = bucketFor(account, profileId, false);
    if (!info) throw Object.assign(new Error("unknown profile"), { status:404 });
    const item = info.items.find(i => i.id === String(itemId));
    if (!item) throw Object.assign(new Error("unknown VOD item in this profile"), { status:404 });
    if (item.kind !== "youtube" && item.kind !== "twitch-vod") throw new Error("only YouTube / Twitch VODs can be downloaded; uploads are already local");
    const key = `${account.twitchUserId}:${item.id}`;
    if (downloads.has(key)) return item.download;
    const dir = downloadDirFor(account, info);
    fs.mkdirSync(dir, { recursive:true });
    const location = ffmpegLocation();
    const args = [...ytDlpBase(item.kind), "-f", remoteFormatFor(item.kind), "--merge-output-format", "mp4", "--newline", "--no-part",
      ...(location ? ["--ffmpeg-location", location] : []),
      "--print", "after_move:filepath", "-o", path.join(dir, `${item.id}.%(ext)s`), item.url];
    const child = spawn(YTDLP_BIN, args, { stdio:["ignore", "pipe", "pipe"] });
    downloads.set(key, child);
    item.download = { state:"downloading", progress:0, dir, startedAt:new Date().toISOString(), error:null, file:null };
    saveState(state);
    let out = "", err = "";
    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      out = (out + text).slice(-8000);
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) { const m = /\[download\]\s+([\d.]+)%/.exec(line); if (m) item.download.progress = Math.min(100, Number(m[1])); }
    });
    child.stderr.on("data", chunk => { err = (err + chunk.toString()).slice(-4000); });
    let finished = false;
    const finish = (ok, message) => {
      if (finished) return;
      finished = true;
      downloads.delete(key);
      if (!item.download) return; // cancelled and removed
      const printed = out.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("[")).pop();
      const file = ok && printed && fs.existsSync(printed) ? printed : null;
      item.download = {
        ...item.download,
        state:file ? "done" : "error",
        progress:file ? 100 : item.download.progress,
        file,
        finishedAt:new Date().toISOString(),
        sizeBytes:file ? fs.statSync(file).size : null,
        error:file ? null : (message || friendlyResolverError(item.kind, err, "download failed").message),
      };
      saveState(state);
    };
    child.on("error", e => finish(false, e.message));
    child.on("close", code => finish(code === 0));
    return item.download;
  }

  function removeDownload(account, profileId, itemId) {
    const info = bucketFor(account, profileId, false);
    if (!info) throw Object.assign(new Error("unknown profile"), { status:404 });
    const item = info.items.find(i => i.id === String(itemId));
    if (!item) throw Object.assign(new Error("unknown VOD item in this profile"), { status:404 });
    const key = `${account.twitchUserId}:${item.id}`;
    const child = downloads.get(key);
    const download = item.download;
    delete item.download;
    saveState(state);
    if (child) { try { child.kill("SIGTERM"); } catch {} }
    removeLocalFiles(download, item.id);
  }

  // The finished file, plus any partial file a cancelled download left.
  function removeLocalFiles(download, itemId) {
    if (!download) return;
    if (download.file) fs.unlink(download.file, () => {});
    if (download.dir) {
      fs.readdir(download.dir, (err, names) => {
        if (err) return;
        for (const name of names) if (name.startsWith(`${itemId}.`)) fs.unlink(path.join(download.dir, name), () => {});
      });
    }
  }

  function getSettings(account) {
    return {
      downloadDir:allowCustomDownloadDir ? String(account.vodSettings?.downloadDir || "") : "",
      preferLocal:preferLocal(account),
      customDirAllowed:allowCustomDownloadDir,
      defaultDir:allowCustomDownloadDir ? path.join(vodDir, safeSegment(account.twitchUserId)) : null,
    };
  }

  function updateSettings(account, body = {}) {
    const next = { ...(account.vodSettings || {}) };
    if (body.preferLocal !== undefined) next.preferLocal = Boolean(body.preferLocal);
    if (body.downloadDir !== undefined) {
      if (!allowCustomDownloadDir) throw Object.assign(new Error("a custom download folder is only available in the desktop app"), { status:403 });
      const dir = String(body.downloadDir || "").trim();
      if (dir && !path.isAbsolute(dir)) throw new Error("choose a full folder path");
      if (dir) {
        try { fs.mkdirSync(dir, { recursive:true }); fs.accessSync(dir, fs.constants.W_OK); }
        catch { throw new Error("CastNexus cannot write to that folder"); }
      }
      next.downloadDir = dir;
    }
    account.vodSettings = next;
    saveState(state);
    return getSettings(account);
  }

  async function refreshTwitchCatalog(account) {
    if (!twitchApi) throw new Error("Twitch API is unavailable");
    const items = await twitchApi.getVideos(account.twitchUserId, { first:100, type:"archive", brokerToken:account.oauthBrokerToken });
    account.twitchVodCatalog = { updatedAt:new Date().toISOString(), items };
    saveState(state);
    return account.twitchVodCatalog;
  }

  async function getTwitchCatalog(account, { refresh = false } = {}) {
    const cache = account.twitchVodCatalog;
    const age = cache?.updatedAt ? Date.now() - Date.parse(cache.updatedAt) : Infinity;
    if (refresh || !Array.isArray(cache?.items) || age > TWITCH_CATALOG_TTL_MS) {
      try { return await refreshTwitchCatalog(account); }
      catch (err) {
        if (Array.isArray(cache?.items)) return { ...cache, stale:true, error:err.message };
        throw err;
      }
    }
    return cache;
  }

  async function playTwitchCatalogItem(account, profileId, videoId, loop) {
    const info = bucketFor(account, profileId);
    if (!info) throw new Error("unknown profile");
    const catalog = await getTwitchCatalog(account);
    const item = (catalog.items || []).find(v => String(v.id) === String(videoId));
    if (!item) throw new Error("Twitch VOD was not found in your account catalog");
    const inputs = await resolveRemote("twitch-vod", item.url);
    return startResolved(account, info, { kind:"twitch-vod", inputs }, { itemId:`twitch:${item.id}`, title:item.title, loop });
  }

  async function ownLiveStatus(account) {
    if (!twitchApi) return { live:false, unavailable:true };
    return twitchApi.isLive({ userId:account.twitchUserId, brokerToken:account.oauthBrokerToken });
  }

  async function startTwitchLive(account, profileId, channelOrUrl) {
    const info = bucketFor(account, profileId);
    if (!info) throw new Error("unknown profile");
    const url = normalizeRemoteUrl("twitch-live", channelOrUrl);
    if (!url) throw new Error("enter a valid Twitch channel name or twitch.tv channel URL");
    const channel = new URL(url).pathname.split("/").filter(Boolean)[0] || account.twitchLogin;
    if (twitchApi) {
      const live = await twitchApi.isLive({ login:channel, brokerToken:account.oauthBrokerToken });
      if (!live.live) throw Object.assign(new Error(`${channel} is not live on Twitch right now. CastNexus will not start an HLS relay until the Twitch API reports the channel live.`), { code:"TWITCH_OFFLINE" });
    }
    const inputs = await resolveRemote("twitch-live", url);
    return startResolved(account, info, { kind:"twitch-live", inputs }, { title:`${channel} · Twitch Live`, loop:false });
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination:(req, file, cb) => {
        const info = bucketFor(req.account, req.query.profileId || req.body?.profileId);
        if (!info) return cb(new Error("unknown profile"));
        req.vodProfileId = info.profile.id;
        const dir = diskDir(req.account, info.profileId);
        fs.mkdirSync(dir, { recursive:true });
        cb(null, dir);
      },
      filename:(req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits:{ fileSize:maxBytes },
    fileFilter:(req, file, cb) => cb(null, VIDEO_MIME_PREFIXES.some(prefix => String(file.mimetype || "").startsWith(prefix))),
  });

  function createApiRouter() {
    const router = express.Router();

    router.get("/items", (req, res) => {
      const info = bucketFor(req.account, req.query.profileId);
      if (!info) return res.status(404).json({ error:"unknown profile" });
      res.json({ profileId:info.profile.id, items:info.items, playlist:playlistFor(info), settings:getSettings(req.account) });
    });

    // Playlist: ordered item ids; plays in order or shuffled, optionally looping.
    const fail = (res, err, code) => res.status(err.status || (err.code === "YOUTUBE_CHALLENGE" ? 422 : 400)).json({ error:err.message, code:err.code || code });
    router.put("/playlist", (req, res) => {
      try { res.json({ ok:true, playlist:setPlaylist(req.account, req.body?.profileId, req.body?.itemIds) }); }
      catch (err) { fail(res, err, "PLAYLIST_FAILED"); }
    });
    router.post("/playlist/add", async (req, res) => {
      try { res.json({ ok:true, ...(await addToPlaylist(req.account, req.body?.profileId, { itemId:req.body?.itemId, twitchVideoId:req.body?.twitchVideoId })) }); }
      catch (err) { fail(res, err, "PLAYLIST_FAILED"); }
    });
    router.post("/playlist/play", async (req, res) => {
      const { profileId, shuffle, loop, startItemId } = req.body || {};
      try { res.json({ ok:true, status:await playPlaylist(req.account, profileId, { shuffle:Boolean(shuffle), loop:Boolean(loop), startItemId:startItemId || null }) }); }
      catch (err) { fail(res, err, "PLAY_FAILED"); }
    });

    // Optional local copies of remote VODs.
    router.post("/items/:id/download", (req, res) => {
      try { res.json({ ok:true, download:startDownload(req.account, req.body?.profileId || req.query.profileId, req.params.id) }); }
      catch (err) { fail(res, err, "DOWNLOAD_FAILED"); }
    });
    router.delete("/items/:id/download", (req, res) => {
      try { removeDownload(req.account, req.query.profileId, req.params.id); res.json({ ok:true }); }
      catch (err) { fail(res, err, "DOWNLOAD_FAILED"); }
    });
    router.get("/settings", (req, res) => res.json(getSettings(req.account)));
    router.put("/settings", (req, res) => {
      try { res.json({ ok:true, settings:updateSettings(req.account, req.body || {}) }); }
      catch (err) { fail(res, err, "SETTINGS_FAILED"); }
    });

    router.get("/twitch-vods", async (req, res) => {
      try { res.json(await getTwitchCatalog(req.account, { refresh:String(req.query.refresh || "") === "1" })); }
      catch (err) { res.status(503).json({ error:err.message }); }
    });

    router.post("/twitch-vods/:id/play", async (req, res) => {
      try {
        const status = await playTwitchCatalogItem(req.account, req.body?.profileId, req.params.id, Boolean(req.body?.loop));
        res.json({ ok:true, status });
      } catch (err) { res.status(400).json({ error:err.message, code:err.code || "TWITCH_VOD_PLAY_FAILED" }); }
    });

    router.get("/twitch-live/status", async (req, res) => {
      try { res.json(await ownLiveStatus(req.account)); }
      catch (err) { res.status(503).json({ error:err.message, live:false }); }
    });

    router.post("/upload", (req, res) => {
      upload.single("file")(req, res, async err => {
        if (err) return res.status(400).json({ error:err.message || "upload failed" });
        if (!req.file) return res.status(400).json({ error:"a video file is required" });
        const info = bucketFor(req.account, req.vodProfileId || req.query.profileId);
        if (!info) return res.status(404).json({ error:"unknown profile" });
        const filePath = path.join(diskDir(req.account, info.profileId), req.file.filename);
        const durationS = await probeDurationSeconds(filePath).catch(() => null);
        const item = {
          id:crypto.randomUUID(), kind:"upload",
          title:path.basename(req.file.originalname, path.extname(req.file.originalname)),
          filename:req.file.filename, originalName:req.file.originalname,
          sizeBytes:req.file.size, durationS, addedAt:new Date().toISOString(),
        };
        info.items.push(item);
        saveState(state);
        res.json({ ok:true, profileId:info.profile.id, item });
      });
    });

    router.post("/remote", async (req, res) => {
      const { profileId, kind, url, authorized } = req.body || {};
      if (!authorized) return res.status(400).json({ error:"confirm that you own or are authorized to rerun this content" });
      if (!REMOTE_KINDS.has(kind)) return res.status(400).json({ error:"kind must be youtube or twitch-vod" });
      const normalized = normalizeRemoteUrl(kind, url);
      if (!normalized) return res.status(400).json({ error:`enter a valid ${kind === "youtube" ? "YouTube" : "Twitch VOD"} URL` });
      const info = bucketFor(req.account, profileId);
      if (!info) return res.status(404).json({ error:"unknown profile" });
      try {
        const metadata = await inspectRemote(kind, normalized);
        const item = {
          id:crypto.randomUUID(), kind, title:metadata.title,
          uploader:metadata.uploader, thumbnail:metadata.thumbnail,
          url:metadata.webpageUrl || normalized, durationS:metadata.durationS,
          addedAt:new Date().toISOString(),
        };
        info.items.push(item);
        saveState(state);
        res.json({ ok:true, profileId:info.profile.id, item });
      } catch (err) {
        res.status(err.code === "YOUTUBE_CHALLENGE" ? 422 : 400).json({ error:err.message, code:err.code || "RESOLVE_FAILED" });
      }
    });

    router.delete("/items/:id", async (req, res) => {
      const info = bucketFor(req.account, req.query.profileId, false);
      if (!info) return res.status(404).json({ error:"unknown profile" });
      const item = info.items.find(i => i.id === req.params.id);
      if (!item) return res.status(404).json({ error:"unknown VOD item in this profile" });
      const running = sessions.get(req.account.twitchUserId);
      if (running?.itemId === item.id) await stop(req.account.twitchUserId);
      info.bucket.items = info.items.filter(i => i.id !== item.id);
      if (Array.isArray(info.bucket.playlist)) info.bucket.playlist = info.bucket.playlist.filter(id => id !== item.id);
      const download = item.download;
      delete item.download;
      const child = downloads.get(`${req.account.twitchUserId}:${item.id}`);
      if (child) { try { child.kill("SIGTERM"); } catch {} }
      removeLocalFiles(download, item.id);
      saveState(state);
      if (item.kind === "upload") {
        const filePath = uploadedFilePath(req.account, info, item);
        if (filePath) fs.unlink(filePath, () => {});
      }
      res.json({ ok:true, profileId:info.profile.id });
    });

    router.post("/play", async (req, res) => {
      const { profileId, itemId, loop } = req.body || {};
      try { res.json({ ok:true, status:await playItem(req.account, profileId, itemId, Boolean(loop)) }); }
      catch (err) { res.status(err.code === "YOUTUBE_CHALLENGE" ? 422 : 400).json({ error:err.message, code:err.code || "PLAY_FAILED" }); }
    });

    router.post("/twitch-live", async (req, res) => {
      const { profileId, channel, authorized } = req.body || {};
      if (!authorized) return res.status(400).json({ error:"confirm that you are authorized to relay this Twitch broadcast" });
      try { res.json({ ok:true, status:await startTwitchLive(req.account, profileId, channel) }); }
      catch (err) { res.status(err.code === "TWITCH_OFFLINE" ? 409 : 400).json({ error:err.message, code:err.code || "TWITCH_LIVE_FAILED" }); }
    });

    router.post("/stop", async (req, res) => {
      await stop(req.account.twitchUserId);
      res.json({ ok:true, status:{ state:"idle" } });
    });

    router.get("/status", (req, res) => res.json(publicStatus(req.account.twitchUserId)));

    // Every profile that has a VOD library, so items saved on an old PC
    // profile can be moved to a VOD profile.
    router.get("/libraries", (req, res) => res.json({ libraries:libraries(req.account) }));
    router.post("/move", async (req, res) => {
      try { res.json({ ok:true, ...(await moveLibrary(req.account, req.body?.fromProfileId, req.body?.toProfileId)) }); }
      catch (err) { res.status(err.status || 400).json({ error:err.message }); }
    });
    return router;
  }

  function libraries(account) {
    ensureCollections(account);
    return Object.entries(account.vodProfiles)
      .map(([id, bucket]) => {
        const profile = profileById(account, id);
        return { profileId:id, name:profile?.name || null, mode:profile?.mode || null, exists:!!profile, items:Array.isArray(bucket?.items) ? bucket.items.length : 0 };
      })
      .filter(row => row.items > 0);
  }

  // Moves every item (and uploaded file) from one profile's VOD library to
  // another's. Used when reruns moved from PC profiles to VOD profiles.
  async function moveLibrary(account, fromProfileId, toProfileId) {
    ensureCollections(account);
    const fromId = safeSegment(fromProfileId || "");
    const fromBucket = account.vodProfiles[fromId];
    if (!fromId || !fromBucket) throw Object.assign(new Error("that profile has no VOD library"), { status:404 });
    const to = bucketFor(account, toProfileId, true);
    if (!to) throw Object.assign(new Error("unknown target profile"), { status:404 });
    if (to.profileId === fromId) throw new Error("source and target are the same profile");
    const running = sessions.get(account.twitchUserId);
    if (running && safeSegment(running.profileId) === fromId) throw Object.assign(new Error("stop the running rerun before moving its library"), { status:409 });

    const srcDir = diskDir(account, fromId), dstDir = diskDir(account, to.profileId);
    await fs.promises.mkdir(dstDir, { recursive:true });
    const known = new Set(to.items.map(i => i.id));
    let moved = 0;
    for (const item of fromBucket.items || []) {
      if (known.has(item.id)) continue;
      if (item.kind === "upload" && item.filename) {
        let target = item.filename;
        if (fs.existsSync(path.join(dstDir, target))) target = `${crypto.randomUUID().slice(0, 8)}-${target}`;
        try {
          await fs.promises.rename(path.join(srcDir, item.filename), path.join(dstDir, target));
        } catch (err) {
          if (err.code === "ENOENT") target = item.filename; // file already gone: move the entry, it stays unplayable
          else if (err.code === "EXDEV") {
            await fs.promises.copyFile(path.join(srcDir, item.filename), path.join(dstDir, target));
            await fs.promises.unlink(path.join(srcDir, item.filename));
          } else throw err;
        }
        item.filename = target;
      }
      to.items.push(item);
      moved++;
    }
    fromBucket.items = [];
    saveState(state);
    return { moved, toProfileId:to.profileId };
  }

  return {
    createApiRouter, bucketFor, diskDir, publicStatus, stop, playItem, startTwitchLive, libraries, moveLibrary,
    playlistFor, setPlaylist, addToPlaylist, playPlaylist, startDownload, removeDownload, getSettings, updateSettings,
    refreshTwitchCatalog, getTwitchCatalog, playTwitchCatalogItem, ownLiveStatus,
    normalizeRemoteUrl, resolveRemote, inspectRemote, ffmpegArgsFor, remoteFormatFor,
  };
}

module.exports = { createProfileVodService, normalizeRemoteUrl, isYouTubeChallenge, ffmpegArgsFor, remoteFormatFor, copiesVideo };
