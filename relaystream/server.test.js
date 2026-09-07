"use strict";

process.env.RELAYSTREAM_SIGNING_SECRET = "a".repeat(32);
process.env.RELAYSTREAM_ADMIN_TOKEN = "test-admin-token";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, validNodeId, signPushToken, verifyPushToken } = require("./server");

async function listen(app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const { port } = server.address();
  return { server, base:`http://127.0.0.1:${port}` };
}

test("nodeId validation", () => {
  assert.equal(validNodeId("a".repeat(36)), true);
  assert.equal(validNodeId("short"), false);
  assert.equal(validNodeId("has spaces"), false);
  assert.equal(validNodeId(""), false);
});

test("push tokens are signed and expire", () => {
  const token = signPushToken("node-1", 1000);
  const claims = verifyPushToken(token);
  assert.equal(claims.nodeId, "node-1");
  assert.equal(verifyPushToken(`${token}x`), null);
  assert.equal(verifyPushToken(""), null);
});

test("register issues a push token and admin can list/ban/unban the node", async () => {
  const { server, base } = await listen(createApp());
  try {
    const registerRes = await fetch(`${base}/v1/nodes/register`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ nodeId:"test-node-1234" }),
    });
    assert.equal(registerRes.status, 200);
    const registered = await registerRes.json();
    assert.equal(registered.nodeId, "test-node-1234");
    assert.ok(registered.pushToken);

    const unauthedList = await fetch(`${base}/v1/admin/nodes`);
    assert.equal(unauthedList.status, 401);

    const list = await fetch(`${base}/v1/admin/nodes`, { headers:{ Authorization:"Bearer test-admin-token" } });
    assert.equal(list.status, 200);
    const { nodes } = await list.json();
    assert.ok(nodes.some(n => n.id === "test-node-1234"));

    const ban = await fetch(`${base}/v1/admin/nodes/test-node-1234/ban`, { method:"POST", headers:{ Authorization:"Bearer test-admin-token" } });
    assert.equal(ban.status, 200);

    const bannedRegister = await fetch(`${base}/v1/nodes/register`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ nodeId:"test-node-1234" }),
    });
    assert.equal(bannedRegister.status, 403);

    const unban = await fetch(`${base}/v1/admin/nodes/test-node-1234/unban`, { method:"POST", headers:{ Authorization:"Bearer test-admin-token" } });
    assert.equal(unban.status, 200);
  } finally {
    server.close();
  }
});

test("mtx-auth allows publish only with a valid push token, and always allows reads", async () => {
  const { server, base } = await listen(createApp());
  try {
    const token = signPushToken("test-node-5678");

    const badPublish = await fetch(`${base}/mtx-auth`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ path:"push/test-node-5678", action:"publish", query:"token=wrong" }),
    });
    assert.equal(badPublish.status, 401);

    const goodPublish = await fetch(`${base}/mtx-auth`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ path:"push/test-node-5678", action:"publish", query:`token=${token}` }),
    });
    assert.equal(goodPublish.status, 200);

    const read = await fetch(`${base}/mtx-auth`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ path:"push/test-node-5678", action:"read" }),
    });
    assert.equal(read.status, 200);

    const unknownPath = await fetch(`${base}/mtx-auth`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ path:"other/thing", action:"read" }),
    });
    assert.equal(unknownPath.status, 404);
  } finally {
    server.close();
  }
});

test("mtx-auth denies a banned node even with a valid token", async () => {
  const { server, base } = await listen(createApp());
  try {
    await fetch(`${base}/v1/admin/nodes/test-node-banned/ban`, { method:"POST", headers:{ Authorization:"Bearer test-admin-token" } });
    const token = signPushToken("test-node-banned");
    const publish = await fetch(`${base}/mtx-auth`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ path:"push/test-node-banned", action:"publish", query:`token=${token}` }),
    });
    assert.equal(publish.status, 403);
  } finally {
    server.close();
  }
});
