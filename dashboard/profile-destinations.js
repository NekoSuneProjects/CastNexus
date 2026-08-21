"use strict";

const { profilesFor, profileById, activeProfileFor, safeSegment } = require("./profile-rtmp");

const VERSION = 1;

function cloneDestination(dest) {
  if (!dest || typeof dest !== "object") return null;
  return {
    id:String(dest.id || ""),
    name:String(dest.name || "Destination"),
    url:String(dest.url || ""),
    layout:String(dest.layout || "source"),
    enabled:Boolean(dest.enabled),
  };
}

function bucketKey(profileId) {
  return safeSegment(profileId || "profile");
}

function ensure(account) {
  if (!account || typeof account !== "object") return false;
  const profiles = profilesFor(account);
  if (!profiles.length) return false;

  let dirty = false;
  if (!account.destinationProfiles || typeof account.destinationProfiles !== "object" || Array.isArray(account.destinationProfiles)) {
    account.destinationProfiles = {};
    dirty = true;
  }

  if (Number(account.destinationProfilesVersion || 0) < VERSION) {
    const legacy = Array.isArray(account.destinations) ? account.destinations.map(cloneDestination).filter(Boolean) : [];
    for (const profile of profiles) {
      const key = bucketKey(profile.id);
      if (!Array.isArray(account.destinationProfiles[key])) {
        // Migration intentionally clones the old global destination set into every
        // existing profile. This preserves current restream configuration while
        // making later edits/toggles independent per profile.
        account.destinationProfiles[key] = legacy.map(dest => ({ ...dest }));
        dirty = true;
      }
    }
    if (legacy.length) {
      account.legacyDestinations = legacy;
      account.destinations = [];
      dirty = true;
    }
    account.destinationProfilesVersion = VERSION;
    dirty = true;
  }

  const valid = new Set(profiles.map(profile => bucketKey(profile.id)));
  for (const profile of profiles) {
    const key = bucketKey(profile.id);
    if (!Array.isArray(account.destinationProfiles[key])) {
      account.destinationProfiles[key] = [];
      dirty = true;
    }
  }
  for (const key of Object.keys(account.destinationProfiles)) {
    if (!valid.has(key)) {
      delete account.destinationProfiles[key];
      dirty = true;
    }
  }
  return dirty;
}

function resolveProfile(account, profileId = null) {
  return profileById(account, profileId) || (!profileId ? activeProfileFor(account) : null);
}

function destinationsFor(account, profileId = null) {
  ensure(account);
  const profile = resolveProfile(account, profileId);
  if (!profile) return [];
  const key = bucketKey(profile.id);
  const bucket = account.destinationProfiles?.[key];
  return Array.isArray(bucket) ? bucket : [];
}

function findDestination(account, destinationId, profileId = null) {
  return destinationsFor(account, profileId).find(dest => String(dest.id) === String(destinationId)) || null;
}

function removeDestination(account, destinationId, profileId = null) {
  ensure(account);
  const profile = resolveProfile(account, profileId);
  if (!profile) return false;
  const key = bucketKey(profile.id);
  const before = destinationsFor(account, profile.id);
  const next = before.filter(dest => String(dest.id) !== String(destinationId));
  if (next.length === before.length) return false;
  account.destinationProfiles[key] = next;
  return true;
}

module.exports = {
  VERSION,
  ensure,
  destinationsFor,
  findDestination,
  removeDestination,
  cloneDestination,
  bucketKey,
};
