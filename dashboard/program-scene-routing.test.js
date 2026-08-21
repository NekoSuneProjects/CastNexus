"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const routingSource = fs.readFileSync(path.join(__dirname, "public", "app-program-routing.js"), "utf8");

function createBrowserHarness({ mode = "pc", compositorEnabled = false, page = "sources" } = {}) {
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });

  const prelude = `
    const calls = [];
    const notices = [];
    const preview = {
      src: "",
      getAttribute(name) { return name === "src" ? this.src : null; },
      setAttribute(name, value) { if (name === "src") this.src = value; }
    };
    const root = {
      querySelector(selector) {
        if (selector === ".preview-frame iframe") return preview;
        return null;
      }
    };
    const document = {
      getElementById(id) { return id === "page-content" ? root : null; }
    };
    const profile = {
      id: "profile-a",
      mode: ${JSON.stringify(mode)},
      compositorEnabled: ${JSON.stringify(compositorEnabled)},
      scene: null
    };
    const S = {
      page: ${JSON.stringify(page)},
      scene: null,
      compositor: { enabled: ${JSON.stringify(compositorEnabled)} },
      status: { twitchLogin: "tester" }
    };

    async function api(url, options = {}) {
      calls.push({ url, method: options.method || "GET", body: options.body || null });
      if (url === "/api/compositor" && (options.method || "GET") === "POST") {
        S.compositor.enabled = Boolean(options.body?.enabled);
        return { ok: true, enabled: S.compositor.enabled };
      }
      return { ok: true };
    }
    function activeProfile() { return profile; }
    async function saveProfileStore() {}
    async function fetchCore() {}
    function toast(message, type) { notices.push({ message, type }); }
    function renderPage() {}
    async function snapshotActiveProfile() {}
    async function activateProfile() {}
    async function setScene() {}

    globalThis.__harness = {
      calls,
      notices,
      preview,
      profile,
      state: S,
      setMode(value) { profile.mode = value; },
      setPage(value) { S.page = value; },
      setSceneState(value) { S.scene = value; },
      setCompositor(value) { S.compositor.enabled = value; }
    };
  `;

  vm.runInContext(prelude, context, { filename: "program-routing-prelude.js" });
  vm.runInContext(routingSource, context, { filename: "app-program-routing.js" });
  return { context, harness: context.__harness };
}

test("PC Program Scene temporarily enables compositor and None restores saved preference", async () => {
  const { context, harness } = createBrowserHarness({ mode: "pc", compositorEnabled: false });

  await context.setScene({ kind: "builtin", name: "startingSoon" });
  assert.equal(harness.calls[0].url, "/api/compositor");
  assert.equal(harness.calls[0].body.enabled, true);
  assert.equal(harness.calls[1].url, "/api/scenes/current");
  assert.equal(harness.calls[1].body.kind, "builtin");
  assert.equal(harness.calls[1].body.name, "startingSoon");
  assert.equal(harness.state.compositor.enabled, true);
  assert.equal(harness.profile.compositorEnabled, false, "temporary scene compositor must not overwrite saved profile preference");

  harness.calls.length = 0;
  await context.setScene({ kind: "none" });
  assert.equal(harness.calls[0].url, "/api/scenes/current");
  const restore = harness.calls.at(-1);
  assert.equal(restore.url, "/api/compositor");
  assert.equal(restore.method, "POST");
  assert.equal(restore.body.enabled, false);
  assert.equal(harness.state.compositor.enabled, false);
  assert.equal(harness.state.scene, null);
});

test("Music Program Scene never starts the second live compositor", async () => {
  const { context, harness } = createBrowserHarness({ mode: "music", compositorEnabled: false });
  await context.setScene({ kind: "builtin", name: "brb" });

  assert.equal(harness.calls.some(call => call.url === "/api/compositor" && call.body?.enabled === true), false);
  assert.equal(harness.calls.some(call => call.url === "/api/scenes/current"), true);
  assert.equal(harness.state.scene?.name, "brb");
});

test("Overview preview follows active Program Scene instead of raw capture", async () => {
  const pc = createBrowserHarness({ mode: "pc", compositorEnabled: false, page: "overview" });
  await pc.context.setScene({ kind: "builtin", name: "ending" });
  assert.equal(pc.harness.preview.src, "/overlay/tester/compositor");

  const music = createBrowserHarness({ mode: "music", compositorEnabled: false, page: "overview" });
  await music.context.setScene({ kind: "builtin", name: "startingSoon" });
  assert.equal(music.harness.preview.src, "/overlay/tester/master");
});
