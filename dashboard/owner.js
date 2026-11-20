"use strict";

// The host owner: the one account with full control over install-wide
// settings (for example which channel the Discord Activity plays).
//
// Picked in this order:
//   1. CASTNEXUS_OWNER_LOGIN=<twitch login>       explicit, recommended on shared installs
//   2. the first name in ALLOWED_TWITCH_LOGINS that has signed in
//   3. the first account that ever signed in to this install (earliest createdAt)

function normaliseLogin(value) { return String(value || "").trim().toLowerCase(); }

function pickOwner(accounts, env = process.env) {
  const list = (Array.isArray(accounts) ? accounts : Object.values(accounts || {})).filter(a => a && a.twitchUserId);
  if (!list.length) return null;
  const byLogin = login => list.find(a => normaliseLogin(a.twitchLogin) === login) || null;

  const explicit = normaliseLogin(env.CASTNEXUS_OWNER_LOGIN);
  if (explicit) return byLogin(explicit);

  for (const login of String(env.ALLOWED_TWITCH_LOGINS || "").split(/[,\s]+/).map(normaliseLogin).filter(Boolean)) {
    const found = byLogin(login);
    if (found) return found;
  }

  let first = null;
  for (const account of list) {
    const at = Date.parse(account.createdAt || "") || Infinity;
    if (!first || at < first.at) first = { account, at };
  }
  return first.account;
}

function isOwner(account, accounts, env = process.env) {
  const owner = pickOwner(accounts, env);
  return !!owner && !!account && String(owner.twitchUserId) === String(account.twitchUserId);
}

module.exports = { pickOwner, isOwner, normaliseLogin };
