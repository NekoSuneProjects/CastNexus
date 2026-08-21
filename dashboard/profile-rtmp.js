"use strict";

const crypto = require("node:crypto");
const profileDestinations = require("./profile-destinations");

const PROFILE_STORE_SYSTEM = "restreamnode-profile-store-v1";
const PROFILE_APP = process.env.PROFILE_APP || "profile";
const RELAY_APP = process.env.RELAY_APP || "relay";

function safeSegment(value) {
  return String(value || "profile").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 120) || "profile";
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
  const profiles = profilesFor(account);
  if (!profiles.length) return null;
  return profiles.find(p => p.id === store?.activeProfileId) || profiles[0] || null;
}

function profileById(account, profileId) {
  if (!profileId) return activeProfileFor(account);
  return profilesFor(account).find(p => String(p.id) === String(profileId)) || null;
}

function generateProfileRtmpKey() {
  return crypto.randomBytes(18).toString("hex");
}

function validRtmpKey(value) {
  return /^[A-Za-z0-9_-]{20,128}$/.test(String(value || ""));
}

function ensureProfileRtmpKeys(account, { legacyKey = null } = {}) {
  const profiles = profilesFor(account);
  if (!profiles.length) return false;
  let dirty = false;

  if (!account.legacyPcProfileId || !profiles.some(p => p.id === account.legacyPcProfileId)) {
    const active = activeProfileFor(account);
    const preferred = active?.mode === "pc" ? active : profiles.find(p => p.mode === "pc") || active || profiles[0];
    if (preferred) {
      account.legacyPcProfileId = preferred.id;
      dirty = true;
    }
  }

  for (const profile of profiles) {
    if (validRtmpKey(profile.rtmpKey)) continue;
    if (legacyKey && profile.id === account.legacyPcProfileId && validRtmpKey(legacyKey)) profile.rtmpKey = String(legacyKey);
    else profile.rtmpKey = generateProfileRtmpKey();
    dirty = true;
  }

  // Destination URLs/keys are private server-side state. Migrate the former
  // account-global list into one bucket per existing profile, then install a
  // non-enumerable compatibility accessor so the existing REST/runtime code
  // automatically reads and writes the currently selected profile's list.
  if (profileDestinations.ensure(account)) dirty = true;
  profileDestinations.installActiveAccessor(account);

  return dirty;
}

function profilePublishPath(profile, app = PROFILE_APP) {
  if (!profile?.id || !validRtmpKey(profile.rtmpKey)) return null;
  return `${safeSegment(app)}/${safeSegment(profile.id)}/${profile.rtmpKey}`;
}

function profileIngestServer(mediaHost, profile, app = PROFILE_APP) {
  if (!profile?.id) return null;
  return `rtmp://${mediaHost}:1935/${safeSegment(app)}/${safeSegment(profile.id)}`;
}

function sourceForProfile(profile) {
  if (profile?.mode === "music") return "music";
  if (profile?.mode === "console") return "console";
  return "pc";
}

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function matchProfilePath(account, pathName, { apps = [PROFILE_APP, RELAY_APP] } = {}) {
  const parts = String(pathName || "").split("/");
  if (parts.length !== 3 || !apps.includes(parts[0])) return null;
  const profile = profilesFor(account).find(p => safeSegment(p.id) === parts[1]);
  if (!profile || !validRtmpKey(profile.rtmpKey) || !secureEqual(profile.rtmpKey, parts[2])) return null;
  return { profile, app:parts[0] };
}

function profileRtmpInfo(account, mediaHost, profileId = null) {
  const profile = profileById(account, profileId);
  if (!profile || !validRtmpKey(profile.rtmpKey)) return null;
  return {
    profileId:profile.id,
    profileName:profile.name || "Profile",
    mode:profile.mode || "pc",
    app:PROFILE_APP,
    server:profileIngestServer(mediaHost, profile, PROFILE_APP),
    key:profile.rtmpKey,
    path:profilePublishPath(profile, PROFILE_APP),
  };
}

module.exports = {
  PROFILE_STORE_SYSTEM,
  PROFILE_APP,
  RELAY_APP,
  safeSegment,
  profileStoreFor,
  profilesFor,
  activeProfileFor,
  profileById,
  generateProfileRtmpKey,
  validRtmpKey,
  ensureProfileRtmpKeys,
  profilePublishPath,
  profileIngestServer,
  profileRtmpInfo,
  sourceForProfile,
  matchProfilePath,
};
