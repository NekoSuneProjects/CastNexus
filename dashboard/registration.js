"use strict";

// A private CastNexus - the usual Docker deployment on a VPS or a Pi that is
// reachable from the internet - wants Twitch sign-in to keep working for the
// people already in state.json while refusing to create an account for anybody
// else. Twitch still authenticates the visitor perfectly well; we simply
// decline to register them.
//
//   DISABLE_REGISTRATION=true
//
// Optionally narrow it further to specific logins, which also covers the case
// where you want a named owner to be able to sign in on a fresh install:
//
//   ALLOWED_TWITCH_LOGINS=nekosunevr,someco-host

const TRUTHY = /^(1|true|yes|on|enabled)$/i;

function registrationDisabled(env = process.env) {
  return TRUTHY.test(String(env.DISABLE_REGISTRATION ?? "").trim());
}

function allowedLogins(env = process.env) {
  return String(env.ALLOWED_TWITCH_LOGINS ?? "")
    .split(/[,\s]+/)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

// Returns { allowed, reason }. `reason` is what gets logged and shaped into the
// user-facing message, so the operator can tell "this instance is closed" apart
// from "your login is not on the list".
//
// The three configurations, in the order they are checked:
//   * ALLOWED_TWITCH_LOGINS set - only those logins may sign in, and they may
//     register. Naming somebody is a stronger statement of intent than the
//     blanket "no new accounts", and it is the only way to bootstrap a fresh
//     install without briefly opening it to the internet.
//   * DISABLE_REGISTRATION set, no allowlist - only accounts already in
//     state.json may sign in. Deliberately strict: there is no "first account
//     bootstraps itself" escape hatch, because on an internet-reachable
//     instance that hands ownership to whoever loads /login first.
//   * neither - open registration, the original behaviour.
function loginDecision({ accountExists = false, login = "", env = process.env } = {}) {
  const allowList = allowedLogins(env);
  const normalised = String(login || "").toLowerCase();
  if (allowList.length) {
    return allowList.includes(normalised)
      ? { allowed: true, reason: accountExists ? "existing-account" : "on-allowlist" }
      : { allowed: false, reason: "not-on-allowlist" };
  }
  if (accountExists) return { allowed: true, reason: "existing-account" };
  if (registrationDisabled(env)) return { allowed: false, reason: "registration-disabled" };
  return { allowed: true, reason: "registration-open" };
}

const REFUSAL_MESSAGES = {
  "registration-disabled": "This CastNexus instance is not accepting new accounts. Ask the operator to sign you in.",
  "not-on-allowlist": "This CastNexus instance only allows specific Twitch accounts to sign in.",
};

function refusalMessage(reason) {
  return REFUSAL_MESSAGES[reason] || "Sign-in was refused by this CastNexus instance.";
}

// True when the configuration can never let anybody in, which is worth shouting
// about at startup rather than letting the operator discover it at the login
// page.
function locksOutEveryone({ accountCount = 0, env = process.env } = {}) {
  if (accountCount > 0) return false;
  if (allowedLogins(env).length) return false;
  return registrationDisabled(env);
}

module.exports = { registrationDisabled, allowedLogins, loginDecision, refusalMessage, locksOutEveryone };
