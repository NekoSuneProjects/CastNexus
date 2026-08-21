"use strict";

const PROFILE_STORE_SYSTEM = "restreamnode-profile-store-v1";
const VERSION = 1;

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

function bucketKey(profileId) { return safeSegment(profileId || "profile"); }

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
        account.destinationProfiles[key] = legacy.map(dest => ({ ...dest }));
        dirty = true;
      }
    }
    if (legacy.length) account.legacyDestinations = legacy;
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
    if (!valid.has(key)) { delete account.destinationProfiles[key]; dirty = true; }
  }
  return dirty;
}

function destinationsFor(account, profileId = null) {
  ensure(account);
  const profile = profileById(account, profileId);
  if (!profile) return [];
  const bucket = account.destinationProfiles?.[bucketKey(profile.id)];
  return Array.isArray(bucket) ? bucket : [];
}

function findDestination(account, destinationId, profileId = null) {
  return destinationsFor(account, profileId).find(dest => String(dest.id) === String(destinationId)) || null;
}

function removeDestination(account, destinationId, profileId = null) {
  ensure(account);
  const profile = profileById(account, profileId);
  if (!profile) return false;
  const key = bucketKey(profile.id);
  const before = destinationsFor(account, profile.id);
  const next = before.filter(dest => String(dest.id) !== String(destinationId));
  if (next.length === before.length) return false;
  account.destinationProfiles[key] = next;
  return true;
}

function installActiveAccessor(account) {
  if (!account || !profilesFor(account).length) return false;
  const descriptor = Object.getOwnPropertyDescriptor(account, "destinations");
  if (descriptor?.get?.__castnexusProfileDestinations) return false;
  const getter = function profileDestinationsGetter() { return destinationsFor(account); };
  getter.__castnexusProfileDestinations = true;
  Object.defineProperty(account, "destinations", {
    configurable:true,
    enumerable:false,
    get:getter,
    set(value) {
      const profile = activeProfileFor(account);
      if (!profile) return;
      account.destinationProfiles[bucketKey(profile.id)] = Array.isArray(value) ? value : [];
    },
  });
  return true;
}

module.exports = {
  VERSION,
  ensure,
  installActiveAccessor,
  destinationsFor,
  findDestination,
  removeDestination,
  cloneDestination,
  bucketKey,
};
