"use strict";

// Install-wide feature switches, set from the environment (Docker .env).
//
//   CASTNEXUS_MUSIC24=true|false             Music 24/7 radio worker + Music profiles
//   CASTNEXUS_PC_STREAMING=true|false        PC / OBS RTMP ingest + PC profiles (and VOD reruns)
//   CASTNEXUS_CONSOLE_STREAMING=true|false   Console capture ingest + Console profiles
//   CASTNEXUS_DISCORD_ACTIVITY=true|false    Discord Activity watch page (/activity)
//
// Everything except the Discord Activity defaults to on, so existing installs
// keep their current behaviour. A switched-off feature is hidden in the
// Studio, refused by its API routes, and its incoming streams are not routed
// to any destination.

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

function envBool(env, name, fallback) {
  const raw = String(env[name] ?? "").trim().toLowerCase();
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  return fallback;
}

function readFeatures(env = process.env) {
  return Object.freeze({
    music24:envBool(env, "CASTNEXUS_MUSIC24", true),
    pcStreaming:envBool(env, "CASTNEXUS_PC_STREAMING", true),
    consoleStreaming:envBool(env, "CASTNEXUS_CONSOLE_STREAMING", true),
    discordActivity:envBool(env, "CASTNEXUS_DISCORD_ACTIVITY", false),
  });
}

// Profile mode -> feature flag. VOD reruns are a PC-profile source, so they
// follow the PC switch.
const MODE_FEATURE = Object.freeze({ pc:"pcStreaming", console:"consoleStreaming", music:"music24" });
const SOURCE_FEATURE = Object.freeze({ ...MODE_FEATURE, rerun:"pcStreaming" });

function profileModeAllowed(mode, features) {
  const key = MODE_FEATURE[mode];
  return key ? !!features[key] : true;
}

function sourceAllowed(source, features) {
  const key = SOURCE_FEATURE[source];
  return key ? !!features[key] : true;
}

function enabledProfileModes(features) {
  return Object.keys(MODE_FEATURE).filter(mode => profileModeAllowed(mode, features));
}

function publicFeatures(features) {
  return { ...features, profileModes:enabledProfileModes(features) };
}

function describe(features) {
  const on = name => features[name] ? "on" : "off";
  return `music24=${on("music24")} pc=${on("pcStreaming")} console=${on("consoleStreaming")} discordActivity=${on("discordActivity")}`;
}

const features = readFeatures();

module.exports = {
  features,
  readFeatures,
  envBool,
  profileModeAllowed:mode => profileModeAllowed(mode, features),
  sourceAllowed:source => sourceAllowed(source, features),
  enabledProfileModes:() => enabledProfileModes(features),
  publicFeatures:() => publicFeatures(features),
  describe:() => describe(features),
  // Pure variants for tests.
  _profileModeAllowed:profileModeAllowed,
  _sourceAllowed:sourceAllowed,
  _enabledProfileModes:enabledProfileModes,
};
