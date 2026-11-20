"use strict";

// Admin dashboard API (/api/admin/*). Host owner only (see owner.js).
//
//   GET    /overview              install health, features, sign-in rules
//   GET    /users                 every account with live / key / profile state
//   POST   /users/:id/block       { blocked } - refuse (or allow again) sign-in
//   POST   /users/:id/sign-out    end every Studio session of that account
//   POST   /users/:id/stop        stop that account's live outputs now
//   DELETE /users/:id             { confirm:<login> } remove the account
//   GET    /legal | PUT /legal    operator name / contact shown on /privacy and /terms
//   GET    /audit                 the last admin actions
//
// The owner can't block, sign out or remove their own account, so the install
// can't be locked out from the Admin page.

const express = require("express");

const AUDIT_LIMIT = 200;
const STARTED_AT = new Date();

function auditEntry(state, by, action, target, detail) {
  if (!Array.isArray(state.adminAudit)) state.adminAudit = [];
  state.adminAudit.push({ at:new Date().toISOString(), by, action, target:target || null, detail:detail || null });
  if (state.adminAudit.length > AUDIT_LIMIT) state.adminAudit = state.adminAudit.slice(-AUDIT_LIMIT);
}

function validateLegal(body = {}) {
  const operatorName = String(body.operatorName ?? "").trim();
  const contactUrl = String(body.contactUrl ?? "").trim();
  const contactEmail = String(body.contactEmail ?? "").trim();
  if (operatorName.length > 120) return { error:"Operator name must be 120 characters or fewer" };
  if (contactUrl && (!/^https?:\/\/[^\s<>"']+$/i.test(contactUrl) || contactUrl.length > 300)) return { error:"Contact URL must be an http(s) URL" };
  if (contactEmail && (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(contactEmail) || contactEmail.length > 200)) return { error:"Contact email is not valid" };
  return { legal:{ operatorName, contactUrl, contactEmail } };
}

function registrationMode(registration, accountCount) {
  const allowList = registration.allowedLogins();
  if (allowList.length) return { mode:"allowlist", allowList, label:`Only ${allowList.join(", ")} can sign in` };
  if (registration.registrationDisabled()) return { mode:"closed", allowList:[], label:`Closed - only the ${accountCount} existing account(s) can sign in` };
  return { mode:"open", allowList:[], label:"Open - any Twitch account can create an account" };
}

function ownerSource(env = process.env) {
  if (String(env.CASTNEXUS_OWNER_LOGIN || "").trim()) return "CASTNEXUS_OWNER_LOGIN";
  if (String(env.ALLOWED_TWITCH_LOGINS || "").trim()) return "ALLOWED_TWITCH_LOGINS";
  return "first sign-in";
}

function createAdminRouter({
  state, saveState, getAccount, hostOwner, activeSourceFor, activeProfileFor,
  stopAccount, features, registration, systemSnapshot, encoderStatus, buildInfo, discordActivityStatus,
  env = process.env,
}) {
  const router = express.Router();
  const accounts = () => Object.values(state.accounts).map(raw => getAccount(raw.twitchUserId)).filter(Boolean);

  function requireOwner(req, res, next) {
    const owner = hostOwner();
    if (owner && String(owner.twitchUserId) === String(req.account.twitchUserId)) return next();
    res.status(403).json({ error:`Only the host owner${owner ? ` (${owner.twitchLogin})` : ""} can open the Admin dashboard`, code:"OWNER_ONLY" });
  }
  router.use(requireOwner);

  function userRow(account, ownerId) {
    const profile = activeProfileFor(account);
    const store = (account.overlays || []).find(o => Array.isArray(o?.config?.profiles));
    return {
      id:String(account.twitchUserId),
      login:account.twitchLogin || null,
      displayName:account.displayName || account.twitchLogin || String(account.twitchUserId),
      profileImageUrl:account.profileImageUrl || null,
      createdAt:account.createdAt || null,
      lastLoginAt:account.lastLoginAt || null,
      isOwner:String(account.twitchUserId) === ownerId,
      blocked:!!account.blocked,
      live:activeSourceFor(account.twitchUserId),
      activeProfile:profile ? { name:profile.name || null, mode:profile.mode || null } : null,
      profileCount:store ? store.config.profiles.length : 0,
      streamKey:{ set:!!account.streamKey, source:account.streamKey ? (account.streamKeySource || "manual") : null },
      destinations:{ total:(account.destinations || []).length, enabled:(account.destinations || []).filter(d => d.enabled).length },
    };
  }

  // Look up the target account and refuse actions on the owner themself.
  function target(req, res, { allowSelf = false } = {}) {
    const account = getAccount(req.params.id);
    if (!account) { res.status(404).json({ error:"unknown account" }); return null; }
    if (!allowSelf && String(account.twitchUserId) === String(req.account.twitchUserId)) {
      res.status(400).json({ error:"You can't do this to the host owner account" });
      return null;
    }
    return account;
  }

  router.get("/overview", (_req, res) => {
    const list = accounts();
    const owner = hostOwner();
    const sys = systemSnapshot();
    res.json({
      build:buildInfo(),
      startedAt:STARTED_AT.toISOString(),
      uptimeSeconds:Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
      owner:owner ? { login:owner.twitchLogin, displayName:owner.displayName || owner.twitchLogin, source:ownerSource(env) } : null,
      registration:registrationMode(registration, list.length),
      features:features(),
      accounts:{ total:list.length, blocked:list.filter(a => a.blocked).length, live:list.filter(a => activeSourceFor(a.twitchUserId)).length },
      host:sys ? { cpuPercent:sys.cpuPercent ?? null, ramUsedBytes:sys.ramUsedBytes ?? null, ramTotalBytes:sys.ramTotalBytes ?? null, loadAverage:sys.loadAverage || null, cores:sys.cores ?? null } : null,
      encoder:encoderStatus(),
      discordActivity:discordActivityStatus(),
    });
  });

  router.get("/users", (_req, res) => {
    const ownerId = String(hostOwner()?.twitchUserId || "");
    const rows = accounts().map(a => userRow(a, ownerId));
    rows.sort((a, b) => (Number(b.isOwner) - Number(a.isOwner)) || (Number(!!b.live) - Number(!!a.live)) || String(a.displayName).localeCompare(String(b.displayName)));
    res.json({ users:rows });
  });

  router.post("/users/:id/block", (req, res) => {
    const account = target(req, res);
    if (!account) return;
    const blocked = req.body?.blocked === true;
    account.blocked = blocked;
    if (blocked) {
      account.sessionEpoch = (Number(account.sessionEpoch) || 0) + 1;
      stopAccount(account.twitchUserId);
    }
    auditEntry(state, req.account.twitchLogin, blocked ? "block" : "unblock", account.twitchLogin);
    saveState(state);
    console.log(`[admin] ${req.account.twitchLogin} ${blocked ? "blocked" : "unblocked"} ${account.twitchLogin}`);
    res.json({ ok:true, user:userRow(account, String(hostOwner()?.twitchUserId || "")) });
  });

  router.post("/users/:id/sign-out", (req, res) => {
    const account = target(req, res);
    if (!account) return;
    account.sessionEpoch = (Number(account.sessionEpoch) || 0) + 1;
    auditEntry(state, req.account.twitchLogin, "sign-out", account.twitchLogin);
    saveState(state);
    console.log(`[admin] ${req.account.twitchLogin} signed out every session of ${account.twitchLogin}`);
    res.json({ ok:true });
  });

  router.post("/users/:id/stop", (req, res) => {
    const account = target(req, res, { allowSelf:true });
    if (!account) return;
    stopAccount(account.twitchUserId);
    auditEntry(state, req.account.twitchLogin, "stop-outputs", account.twitchLogin);
    saveState(state);
    console.log(`[admin] ${req.account.twitchLogin} stopped the live outputs of ${account.twitchLogin}`);
    res.json({ ok:true });
  });

  router.delete("/users/:id", (req, res) => {
    const account = target(req, res);
    if (!account) return;
    if (String(req.body?.confirm || "").toLowerCase() !== String(account.twitchLogin || "").toLowerCase()) {
      return res.status(400).json({ error:`Type the login "${account.twitchLogin}" to confirm` });
    }
    stopAccount(account.twitchUserId);
    delete state.accounts[account.twitchUserId];
    if (state.discordActivity?.channel && state.discordActivity.channel === String(account.twitchLogin || "").toLowerCase()) state.discordActivity.channel = null;
    auditEntry(state, req.account.twitchLogin, "remove-account", account.twitchLogin);
    saveState(state);
    console.log(`[admin] ${req.account.twitchLogin} removed the account ${account.twitchLogin}`);
    res.json({ ok:true });
  });

  router.get("/legal", (_req, res) => res.json({ legal:{ operatorName:"", contactUrl:"", contactEmail:"", ...(state.legal || {}) } }));
  router.put("/legal", (req, res) => {
    const checked = validateLegal(req.body || {});
    if (checked.error) return res.status(400).json({ error:checked.error });
    state.legal = { ...checked.legal, updatedAt:new Date().toISOString() };
    auditEntry(state, req.account.twitchLogin, "update-legal", null, checked.legal.operatorName || "(cleared)");
    saveState(state);
    res.json({ ok:true, legal:state.legal });
  });

  router.get("/audit", (_req, res) => res.json({ entries:(state.adminAudit || []).slice(-100).reverse() }));

  return router;
}

module.exports = { createAdminRouter, validateLegal, registrationMode, ownerSource, auditEntry };
