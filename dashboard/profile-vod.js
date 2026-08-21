"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const express = require("express");
const multer = require("multer");
const { safeSegment, profileById, activeProfileFor } = require("./profile-music");
const { detectEncoder, globalEncoderArgs, videoEncoderArgs } = require("./gpu-encoder");

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
  const format = kind === "youtube" ? "bestvideo[height<=1080]+bestaudio/best[height<=1080]" : "best";
  try {
    const { stdout } = await capture(YTDLP_BIN, [...ytDlpBase(kind), "-g", "-f", format, url], { timeoutMs: 60_000 });
    const urls = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!urls.length) throw new Error("resolver returned no playable URL");
    return urls.slice(0, 2);
  } catch (err) {
    throw friendlyResolverError(kind, err.stderr, err.message);
  }
}

function ffmpegArgsFor(source, outputUrl, options = {}) {
  const selected = options.forceCpu ? { id:"libx264", encoder:"libx264", hardware:false, label:"CPU · x264" } : detectEncoder();
  const args = ["-hide_banner", "-loglevel", "warning", "-nostats", ...globalEncoderArgs(selected)];
  const isLive = source.kind === "twitch-live";
  const inputs = source.inputs || [];

  for (const input of inputs) {
    if (!isLive) args.push("-re");
    args.push("-i", input);
  }

  args.push("-map", "0:v:0");
  if (inputs.length > 1) args.push("-map", "1:a:0?");
  else args.push("-map", "0:a:0?");

  // Twitch's HLS/VOD output is already stream-compatible most of the time, so
  // preserve it without a pointless encode. Uploaded/YouTube media is normalized.
  if (source.kind === "twitch-live" || source.kind === "twitch-vod") {
    args.push("-c:v", "copy", "-c:a", "copy");
  } else {
    const fps = Number(process.env.VOD_FPS || 30);
    let vf = "scale=1920:1080:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";
    if (selected.id === "vaapi") vf += ",format=nv12,hwupload";
    else vf += ",format=yuv420p";
    args.push(
      "-vf", vf,
      "-r", String(fps),
      ...videoEncoderArgs(selected, {
        fps,
        bitrate:process.env.VOD_VIDEO_BITRATE || "6000k",
        maxrate:process.env.VOD_VIDEO_MAXRATE || "6500k",
        bufsize:process.env.VOD_VIDEO_BUFSIZE || "12000k",
        x264Preset:process.env.VOD_X264_PRESET || "veryfast",
      }),
      "-c:a", "aac",
      "-b:a", process.env.VOD_AUDIO_BITRATE || "160k",
      "-ar", "48000",
      "-ac", "2"
    );
  }

  args.push("-f", "flv", "-flvflags", "no_duration_filesize", outputUrl);
  return args;
}

function createProfileVodService({ state, saveState, vodDir, maxBytes, probeDurationSeconds, rtmpOrigin = "rtmp://127.0.0.1:1935", twitchApi = null }) {
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
      startedAt:session.startedAt,
      error:session.error || null,
      encoder:session.encoder || null,
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

  async function sourceForItem(account, info, item) {
    if (item.kind === "upload") {
      const filePath = uploadedFilePath(account, info, item);
      if (!filePath || !fs.existsSync(filePath)) throw new Error("uploaded VOD file is missing");
      return { kind:"upload", inputs:[filePath] };
    }
    if (item.kind === "youtube" || item.kind === "twitch-vod") return { kind:item.kind, inputs:await resolveRemote(item.kind, item.url) };
    throw new Error("unsupported VOD source");
  }

  async function startResolved(account, info, source, meta) {
    await stop(account.twitchUserId);
    const outputUrl = `${rtmpOrigin}/relay/${encodeURIComponent(account.pcKey)}`;
    const encoder = (source.kind === "twitch-live" || source.kind === "twitch-vod") ? { label:"Stream copy", hardware:false } : detectEncoder();
    const session = {
      state:"starting",
      profileId:info.profile.id,
      itemId:meta.itemId || null,
      kind:source.kind,
      title:meta.title || "Rerun",
      loop:!!meta.loop,
      startedAt:new Date().toISOString(),
      error:null,
      encoder:encoder.label,
      child:null,
      manualStop:false,
      forceCpu:false,
    };
    sessions.set(account.twitchUserId, session);

    const launch = () => {
      if (session.manualStop || sessions.get(account.twitchUserId) !== session) return;
      session.state = "starting";
      const started = Date.now();
      const child = spawn(FFMPEG_BIN, ffmpegArgsFor(source, outputUrl, { forceCpu:session.forceCpu }), { stdio:["ignore", "ignore", "pipe"] });
      session.child = child;
      let stderrTail = "";
      child.stderr.on("data", chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-6000); });
      child.on("error", err => { session.error = err.message; session.state = "error"; });
      child.once("spawn", () => { session.state = "playing"; });
      child.once("close", code => {
        if (session.child === child) session.child = null;
        if (session.manualStop || sessions.get(account.twitchUserId) !== session) return;
        const fastFailure = code !== 0 && Date.now() - started < 8000;
        if (fastFailure && encoder.hardware && source.kind !== "twitch-live" && source.kind !== "twitch-vod" && !session.forceCpu) {
          session.forceCpu = true;
          session.encoder = "CPU · x264 fallback";
          session.state = "restarting";
          return setTimeout(launch, 500);
        }
        if (code === 0 && session.loop && source.kind !== "twitch-live") {
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

  async function refreshTwitchCatalog(account) {
    if (!twitchApi) throw new Error("Twitch API is unavailable");
    const items = await twitchApi.getVideos(account.twitchUserId, { first:100, type:"archive" });
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
    return twitchApi.isLive({ userId:account.twitchUserId });
  }

  async function startTwitchLive(account, profileId, channelOrUrl) {
    const info = bucketFor(account, profileId);
    if (!info) throw new Error("unknown profile");
    const url = normalizeRemoteUrl("twitch-live", channelOrUrl);
    if (!url) throw new Error("enter a valid Twitch channel name or twitch.tv channel URL");
    const channel = new URL(url).pathname.split("/").filter(Boolean)[0] || account.twitchLogin;
    if (twitchApi) {
      const live = await twitchApi.isLive({ login:channel });
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
      res.json({ profileId:info.profile.id, items:info.items });
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
    return router;
  }

  return {
    createApiRouter, bucketFor, diskDir, publicStatus, stop, playItem, startTwitchLive,
    refreshTwitchCatalog, getTwitchCatalog, playTwitchCatalogItem, ownLiveStatus,
    normalizeRemoteUrl, resolveRemote, inspectRemote, ffmpegArgsFor,
  };
}

module.exports = { createProfileVodService, normalizeRemoteUrl, isYouTubeChallenge, ffmpegArgsFor };
