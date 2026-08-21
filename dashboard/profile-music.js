"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const express = require("express");
const multer = require("multer");

const PROFILE_STORE_SYSTEM = "restreamnode-profile-store-v1";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

function defaultMusicSettings() {
  return { shuffle: false, loop: true, volume: 0.7 };
}

function safeSegment(value) {
  return String(value || "legacy").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120) || "legacy";
}

function profileStoreFor(account) {
  return (account?.overlays || []).find(o => o?.config?.system === PROFILE_STORE_SYSTEM)?.config || null;
}

function profilesFor(account) {
  const store = profileStoreFor(account);
  return Array.isArray(store?.profiles) ? store.profiles : [];
}

function activeProfileFor(account) {
  const store = profileStoreFor(account);
  if (!store) return null;
  return profilesFor(account).find(p => p.id === store.activeProfileId) || profilesFor(account)[0] || null;
}

function profileById(account, profileId) {
  if (!profileId) return activeProfileFor(account);
  return profilesFor(account).find(p => p.id === profileId) || null;
}

function coverFilenameFor(trackId) {
  return `${safeSegment(trackId)}.cover.jpg`;
}

function extractEmbeddedCover(audioPath, coverPath) {
  return new Promise((resolve) => {
    try { fs.unlinkSync(coverPath); } catch {}
    fs.mkdirSync(path.dirname(coverPath), { recursive: true });

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (!ok) {
        try { fs.unlinkSync(coverPath); } catch {}
      }
      resolve(Boolean(ok));
    };

    let child;
    try {
      child = spawn(FFMPEG_BIN, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", audioPath,
        "-map", "0:v:0",
        "-frames:v", "1",
        "-c:v", "mjpeg",
        "-q:v", "3",
        coverPath,
      ], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      return finish(false);
    }

    child.on("error", () => finish(false));
    child.on("close", (code) => {
      let good = code === 0;
      if (good) {
        try { good = fs.statSync(coverPath).size > 0; } catch { good = false; }
      }
      finish(good);
    });
  });
}

function createProfileMusicService({ state, saveState, musicDir, maxBytes, musicEngine, events }) {
  const engines = new Map();
  const coverProbes = new Set();

  function ensureCollections(account) {
    let dirty = false;
    if (!account.musicProfiles || typeof account.musicProfiles !== "object" || Array.isArray(account.musicProfiles)) {
      account.musicProfiles = {};
      dirty = true;
    }
    if (!Array.isArray(account.musicTracks)) { account.musicTracks = []; dirty = true; }
    if (!account.musicSettings || typeof account.musicSettings !== "object") { account.musicSettings = defaultMusicSettings(); dirty = true; }
    if (dirty) saveState(state);
  }

  function resolveProfile(account, requestedProfileId, { allowLegacy = true } = {}) {
    ensureCollections(account);
    const profiles = profilesFor(account);
    if (requestedProfileId) {
      const found = profiles.find(p => p.id === requestedProfileId);
      if (!found) return null;
      return found;
    }
    return activeProfileFor(account) || (allowLegacy ? { id: "legacy", name: "Legacy profile", mode: "pc", canvasMode: "landscape" } : null);
  }

  function bucketFor(account, requestedProfileId, { create = true, migrate = true } = {}) {
    ensureCollections(account);
    const profile = resolveProfile(account, requestedProfileId);
    if (!profile) return null;
    const profileId = safeSegment(profile.id);

    let bucket = account.musicProfiles[profileId];
    if (!bucket && create) {
      bucket = { tracks: [], settings: defaultMusicSettings(), createdAt: new Date().toISOString() };
      account.musicProfiles[profileId] = bucket;
    }
    if (!bucket) return { profile, profileId, tracks: [], settings: defaultMusicSettings(), bucket: null };

    if (!Array.isArray(bucket.tracks)) bucket.tracks = [];
    if (!bucket.settings || typeof bucket.settings !== "object") bucket.settings = defaultMusicSettings();

    // One-time migration for pre-profile CastNexus/RestreamNode installs.
    // We attach the former account-wide library to the active/first profile
    // and physically move files into that profile directory where possible.
    if (migrate && !account.musicProfileMigrationDone && ((account.musicTracks || []).length || account.musicSettings)) {
      const target = activeProfileFor(account) || profile;
      if (target && safeSegment(target.id) === profileId) {
        const legacyTracks = Array.isArray(account.musicTracks) ? account.musicTracks : [];
        if (legacyTracks.length && bucket.tracks.length === 0) {
          const oldDir = path.join(musicDir, account.twitchUserId);
          const newDir = path.join(oldDir, profileId);
          fs.mkdirSync(newDir, { recursive: true });
          for (const track of legacyTracks) {
            const from = path.join(oldDir, track.filename);
            const to = path.join(newDir, track.filename);
            try {
              if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
              else if (fs.existsSync(from) && fs.existsSync(to)) fs.unlinkSync(from);
            } catch (err) {
              console.warn(`[profile-music] could not migrate ${track.filename}: ${err.message}`);
            }
          }
          bucket.tracks = legacyTracks.map(t => ({ ...t }));
        }
        bucket.settings = { ...defaultMusicSettings(), ...(account.musicSettings || {}) };
        account.musicTracks = [];
        account.musicSettings = defaultMusicSettings();
        account.musicProfileMigrationDone = true;
        account.musicMigratedProfileId = target.id;
        saveState(state);
      }
    }

    return { profile, profileId, tracks: bucket.tracks, settings: bucket.settings, bucket };
  }

  function diskDir(account, profileId) {
    return path.join(musicDir, safeSegment(account.twitchUserId), safeSegment(profileId));
  }

  function filePathFor(account, profileId, trackId) {
    const info = bucketFor(account, profileId, { create: false });
    const track = info?.tracks.find(t => t.id === trackId);
    return track ? path.join(diskDir(account, info.profileId), track.filename) : null;
  }

  function coverPathFor(account, profileId, trackId) {
    const info = bucketFor(account, profileId, { create: false });
    const track = info?.tracks.find(t => t.id === trackId);
    if (!track?.coverFilename) return null;
    const coverPath = path.join(diskDir(account, info.profileId), track.coverFilename);
    return fs.existsSync(coverPath) ? coverPath : null;
  }

  function queueCoverProbe(account, info, track) {
    if (!track?.filename || track.coverChecked === true) return;
    const key = `${account.twitchUserId}:${info.profileId}:${track.id}`;
    if (coverProbes.has(key)) return;
    coverProbes.add(key);

    const coverFilename = coverFilenameFor(track.id);
    const audioPath = path.join(diskDir(account, info.profileId), track.filename);
    const coverPath = path.join(diskDir(account, info.profileId), coverFilename);

    extractEmbeddedCover(audioPath, coverPath)
      .then((found) => {
        const fresh = bucketFor(account, info.profile.id, { create: false, migrate: false });
        const current = fresh?.tracks.find(t => t.id === track.id);
        if (!current) return;
        current.coverChecked = true;
        if (found) current.coverFilename = coverFilename;
        else delete current.coverFilename;
        saveState(state);
      })
      .catch(() => {})
      .finally(() => coverProbes.delete(key));
  }

  function engineFor(account, profileId) {
    const info = bucketFor(account, profileId);
    if (!info) return null;
    const key = `${account.twitchUserId}:${info.profileId}`;
    let engine = engines.get(key);
    if (!engine) {
      engine = musicEngine.engineFor(key, () => {
        const fresh = bucketFor(account, info.profile.id);
        return fresh ? { musicTracks: fresh.tracks, musicSettings: fresh.settings } : { musicTracks: [], musicSettings: defaultMusicSettings() };
      }, (now) => events?.publish?.(account.twitchUserId, { type: "music", profileId: info.profile.id, now }));
      engines.set(key, engine);
    }
    return engine;
  }

  function getNow(account, profileId, { respectScene = false } = {}) {
    const info = bucketFor(account, profileId);
    if (!info) return { mode: "idle", track: null, positionS: 0, durationS: 0, volume: 0.7 };

    if (respectScene && info.profile.mode !== "music") {
      const sceneName = account.currentScene?.kind === "builtin" ? account.currentScene.name : null;
      const allowedScene = ["startingSoon", "brb", "ending"].includes(sceneName);
      if (!info.profile.sceneMusicEnabled || !allowedScene) {
        return { mode: "idle", track: null, positionS: 0, durationS: 0, volume: info.settings.volume ?? 0.7 };
      }
    }

    const engine = engineFor(account, info.profile.id);
    engine?.ensureRunning();
    const now = engine?.getNow() || { mode: "idle", track: null, positionS: 0, durationS: 0, volume: info.settings.volume ?? 0.7 };
    if (now.track) {
      const storedTrack = info.tracks.find(t => t.id === now.track.id);
      if (storedTrack) {
        if (storedTrack.coverChecked !== true) queueCoverProbe(account, info, storedTrack);
        now.track.coverEmbedded = Boolean(coverPathFor(account, info.profile.id, storedTrack.id));
      }
    }
    return now;
  }

  function hasTracks(account, profileId) {
    return (bucketFor(account, profileId, { create: false })?.tracks.length || 0) > 0;
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const info = bucketFor(req.account, req.query.profileId || req.body?.profileId);
        if (!info) return cb(new Error("unknown profile"));
        req.musicProfileId = info.profile.id;
        const dir = diskDir(req.account, info.profileId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: maxBytes },
    fileFilter: (req, file, cb) => cb(null, String(file.mimetype || "").startsWith("audio/")),
  });

  function createApiRouter() {
    const router = express.Router();

    router.get("/tracks", (req, res) => {
      const info = bucketFor(req.account, req.query.profileId);
      if (!info) return res.status(404).json({ error: "unknown profile" });
      res.json({ profileId: info.profile.id, tracks: info.tracks });
    });

    router.post("/tracks", (req, res) => {
      upload.single("file")(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message || "upload failed" });
        if (!req.file) return res.status(400).json({ error: "an audio file is required" });
        const info = bucketFor(req.account, req.musicProfileId || req.query.profileId);
        if (!info) return res.status(404).json({ error: "unknown profile" });
        const filePath = path.join(diskDir(req.account, info.profileId), req.file.filename);
        const durationS = await musicEngine.probeDurationSeconds(filePath);
        const trackId = crypto.randomUUID();
        const coverFilename = coverFilenameFor(trackId);
        const embeddedCover = await extractEmbeddedCover(filePath, path.join(diskDir(req.account, info.profileId), coverFilename));
        const track = {
          id: trackId,
          title: path.basename(req.file.originalname, path.extname(req.file.originalname)),
          artist: "",
          filename: req.file.filename,
          sizeBytes: req.file.size,
          durationS,
          coverChecked: true,
          ...(embeddedCover ? { coverFilename } : {}),
          addedAt: new Date().toISOString(),
        };
        info.tracks.push(track);
        saveState(state);
        engineFor(req.account, info.profile.id)?.refresh();
        res.json({ ok: true, profileId: info.profile.id, track: { ...track, coverEmbedded: embeddedCover } });
      });
    });

    router.put("/tracks/:id", (req, res) => {
      const info = bucketFor(req.account, req.query.profileId);
      if (!info) return res.status(404).json({ error: "unknown profile" });
      const track = info.tracks.find(t => t.id === req.params.id);
      if (!track) return res.status(404).json({ error: "unknown track in this profile" });
      const { title, artist } = req.body || {};
      if (title !== undefined && String(title).trim()) track.title = String(title).trim();
      if (artist !== undefined) track.artist = String(artist).trim();
      saveState(state);
      res.json({ ok: true, profileId: info.profile.id, track });
    });

    router.delete("/tracks/:id", (req, res) => {
      const info = bucketFor(req.account, req.query.profileId);
      if (!info) return res.status(404).json({ error: "unknown profile" });
      const track = info.tracks.find(t => t.id === req.params.id);
      if (!track) return res.status(404).json({ error: "unknown track in this profile" });
      info.bucket.tracks = info.tracks.filter(t => t.id !== req.params.id);
      saveState(state);
      fs.unlink(path.join(diskDir(req.account, info.profileId), track.filename), () => {});
      if (track.coverFilename) fs.unlink(path.join(diskDir(req.account, info.profileId), track.coverFilename), () => {});
      engineFor(req.account, info.profile.id)?.refresh();
      res.json({ ok: true, profileId: info.profile.id });
    });

    router.get("/settings", (req, res) => {
      const info = bucketFor(req.account, req.query.profileId);
      if (!info) return res.status(404).json({ error: "unknown profile" });
      res.json({ ...info.settings });
    });

    router.post("/settings", (req, res) => {
      const info = bucketFor(req.account, req.query.profileId);
      if (!info) return res.status(404).json({ error: "unknown profile" });
      const { shuffle, loop, volume } = req.body || {};
      if (shuffle !== undefined) info.settings.shuffle = Boolean(shuffle);
      if (loop !== undefined) info.settings.loop = Boolean(loop);
      if (volume !== undefined) {
        const v = Number(volume);
        if (!Number.isFinite(v) || v < 0 || v > 1) return res.status(400).json({ error: "volume must be between 0 and 1" });
        info.settings.volume = v;
      }
      if (info.profile) info.profile.musicSettings = { ...info.settings };
      saveState(state);
      engineFor(req.account, info.profile.id)?.refresh();
      res.json({ ok: true, profileId: info.profile.id, musicSettings: info.settings });
    });

    return router;
  }

  return {
    PROFILE_STORE_SYSTEM,
    activeProfileFor,
    profileById,
    resolveProfile,
    bucketFor,
    getNow,
    hasTracks,
    filePathFor,
    coverPathFor,
    diskDir,
    engineFor,
    createApiRouter,
  };
}

module.exports = { createProfileMusicService, PROFILE_STORE_SYSTEM, activeProfileFor, profileById, defaultMusicSettings, safeSegment, extractEmbeddedCover };
