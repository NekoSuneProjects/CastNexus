"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createAdminRouter, validateLegal, registrationMode } = require("./admin");

test("legal details are validated", () => {
  assert.deepEqual(validateLegal({ operatorName:" Neko ", contactUrl:"https://x.example/contact", contactEmail:"me@x.example" }).legal, { operatorName:"Neko", contactUrl:"https://x.example/contact", contactEmail:"me@x.example" });
  assert.match(validateLegal({ contactUrl:"javascript:alert(1)" }).error, /http/);
  assert.match(validateLegal({ contactEmail:"nope" }).error, /email/);
  assert.match(validateLegal({ operatorName:"x".repeat(121) }).error, /120/);
});

test("registration mode reflects the env rules", () => {
  const reg = (allow, disabled) => ({ allowedLogins:() => allow, registrationDisabled:() => disabled });
  assert.equal(registrationMode(reg([], false), 1).mode, "open");
  assert.equal(registrationMode(reg([], true), 1).mode, "closed");
  assert.equal(registrationMode(reg(["neko"], false), 1).mode, "allowlist");
});

function harness() {
  const state = { accounts:{
    1:{ twitchUserId:"1", twitchLogin:"owner", createdAt:"2026-01-01T00:00:00Z", destinations:[] },
    2:{ twitchUserId:"2", twitchLogin:"friend", createdAt:"2026-02-01T00:00:00Z", streamKey:"live_x", streamKeySource:"oauth", destinations:[{ enabled:true }, { enabled:false }] },
  } };
  const stopped = [];
  let signedIn = "1";
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.account = state.accounts[signedIn]; next(); });
  app.use("/api/admin", createAdminRouter({
    state, saveState:() => {}, getAccount:id => state.accounts[id],
    hostOwner:() => state.accounts[1], activeSourceFor:id => id === "2" ? "console" : null, activeProfileFor:() => null,
    stopAccount:id => stopped.push(String(id)), features:() => ({ music24:false }), registration:{ allowedLogins:() => [], registrationDisabled:() => true },
    systemSnapshot:() => ({ cpuPercent:12.5, ramUsedBytes:1, ramTotalBytes:2 }), encoderStatus:() => ({ label:"CPU" }),
    buildInfo:() => ({ version:"1.0.0" }), discordActivityStatus:() => ({ enabled:false }), env:{},
  }));
  return { app, state, stopped, as:id => { signedIn = id; } };
}

async function serve(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const call = async (p, method = "GET", body) => {
    const r = await fetch(base + p, { method, headers:{ "content-type":"application/json" }, body:body ? JSON.stringify(body) : undefined });
    return { status:r.status, json:await r.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

test("only the host owner can use the admin API", async () => {
  const h = harness();
  await serve(h.app, async call => {
    h.as("2");
    assert.equal((await call("/overview")).status, 403);
    h.as("1");
    const o = (await call("/overview")).json;
    assert.equal(o.accounts.total, 2); assert.equal(o.accounts.live, 1); assert.equal(o.registration.mode, "closed");
  });
});

test("users list, block, sign-out, stop and remove", async () => {
  const h = harness();
  await serve(h.app, async call => {
    const users = (await call("/users")).json.users;
    assert.equal(users[0].login, "owner", "owner first");
    const friend = users.find(u => u.login === "friend");
    assert.deepEqual(friend.streamKey, { set:true, source:"oauth" });
    assert.deepEqual(friend.destinations, { total:2, enabled:1 });
    assert.equal(friend.live, "console");

    assert.equal((await call("/users/1/block", "POST", { blocked:true })).status, 400, "owner can't block themself");
    assert.equal((await call("/users/2/block", "POST", { blocked:true })).json.user.blocked, true);
    assert.equal(h.state.accounts[2].sessionEpoch, 1, "blocking ends sessions");
    assert.deepEqual(h.stopped, ["2"], "blocking stops the stream");
    await call("/users/2/sign-out", "POST");
    assert.equal(h.state.accounts[2].sessionEpoch, 2);
    await call("/users/2/stop", "POST");
    assert.deepEqual(h.stopped, ["2", "2"]);

    assert.equal((await call("/users/2", "DELETE", { confirm:"wrong" })).status, 400);
    assert.equal((await call("/users/2", "DELETE", { confirm:"friend" })).status, 200);
    assert.equal(h.state.accounts[2], undefined);

    const audit = (await call("/audit")).json.entries.map(e => e.action);
    assert.deepEqual(audit, ["remove-account", "stop-outputs", "sign-out", "block"]);
  });
});

test("legal details round-trip", async () => {
  const h = harness();
  await serve(h.app, async call => {
    assert.equal((await call("/legal", "PUT", { contactUrl:"ftp://x" })).status, 400);
    await call("/legal", "PUT", { operatorName:"Neko", contactEmail:"me@x.example" });
    const legal = (await call("/legal")).json.legal;
    assert.equal(legal.operatorName, "Neko"); assert.equal(legal.contactEmail, "me@x.example");
  });
});
