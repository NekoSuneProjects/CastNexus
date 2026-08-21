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
    const toggle = { checked: false, disabled: false, title: "" };
    const root = {
      querySelector(selector) {
        if (selector === ".preview-frame iframe") return preview;
        if (selector === "#compositor-toggle") return toggle;
        return null;
      }
    };
    const document = {
      getElementById(id) { return id === "page-content" ? root : null; }
    };
    const profile = {
      id: "profile-a",
      mode: ${JSON.stringify(mode)},
      canvasMode: "landscape",
      compositorEnabled: ${JSON.stringify(compositorEnabled)},
      musicVisual: { station: "Test Radio" },
      scene: null
    };
    const S = {
      page: ${JSON.stringify(page)},
      scene: null,
      compositor: { enabled: ${JSON.stringify(compositorEnabled)} },
      status: { twitchLogin: "tester" },
      profiles: [profile]
    };

    async function api(url, options = {}) {
      calls.push({ url, method: options.method || "GET", body: options.body || null });
      if (url === "/api/compositor" && (options.method || "GET") === "POST") {
        S.compositor.enabled = Boolean(options.body?.enabled);
        return { ok: true, enabled: S.compositor.enabled };
      }
      if (url === "/api/scenes/current" && (options.method || "GET") === "POST") {
        const requested = options.body || { kind: "none" };
        return { ok: true, currentScene: requested.kind === "none" ? null : requested };
      }
      return { ok: true };
    }
    function activeProfile() { return profile; }
    function profileMusicUrl() { return "/overlay/tester/music/profile-a?layout=landscape&station=Test+Radio"; }
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
      toggle,
      profile,
      state: S,
      setMode(value) { profile.mode = value; },
      setPage(value) { S.page = value; },
      setSceneState(value) { S.scene = value; },
      setCompositor(value) { S.compositor.enabled = value; profile.compositorEnabled = value; }
    };
  `;

  vm.runInContext(prelude, context, { filename: "program-routing-prelude.js" });
  vm.runInContext(routingSource, context, { filename: "app-program-routing.js" });
  return { context, harness: context.__harness };
}

test("PC Program engine starts once, then every scene including None is SSE-only", async () => {
  const { context, harness } = createBrowserHarness({ mode: "pc", compositorEnabled: false });

  await context.setScene({ kind: "builtin", name: "startingSoon" });
  assert.equal(harness.calls[0].url, "/api/compositor", "first use may start the persistent Program compositor once");
  assert.equal(harness.calls[0].body.enabled, true);
  assert.equal(harness.calls[1].url, "/api/scenes/current");
  assert.equal(harness.state.compositor.enabled, true);
  assert.equal(harness.profile.compositorEnabled, true, "persistent realtime Program compositor becomes the saved profile behaviour");

  harness.calls.length = 0;
  await context.setScene({ kind: "builtin", name: "brb" });
  await context.setScene({ kind: "builtin", name: "ending" });
  await context.setScene({ kind: "none" });

  assert.equal(harness.calls.filter(call => call.url === "/api/compositor").length, 0, "scene changes must never restart compositor FFmpeg");
  assert.equal(harness.calls.filter(call => call.url === "/api/scenes/current").length, 3);
  assert.equal(harness.state.compositor.enabled, true, "None keeps the compositor alive and exposes live video underneath");
  assert.equal(harness.state.scene, null);
});

test("already-running PC compositor never receives a compositor toggle during scene switching", async () => {
  const { context, harness } = createBrowserHarness({ mode: "pc", compositorEnabled: true });

  for (const scene of [
    { kind:"builtin", name:"startingSoon" },
    { kind:"builtin", name:"brb" },
    { kind:"builtin", name:"ending" },
    { kind:"none" },
  ]) await context.setScene(scene);

  assert.equal(harness.calls.some(call => call.url === "/api/compositor"), false);
});

test("Music Program Scene never starts the normal live compositor", async () => {
  const { context, harness } = createBrowserHarness({ mode: "music", compositorEnabled: false });
  await context.setScene({ kind: "builtin", name: "brb" });
  await context.setScene({ kind: "none" });

  assert.equal(harness.calls.some(call => call.url === "/api/compositor"), false);
  assert.equal(harness.calls.filter(call => call.url === "/api/scenes/current").length, 2);
  assert.equal(harness.state.scene, null);
  assert.match(harness.notices.at(-1)?.message || "", /Music scene/);
});

test("Overview preview uses persistent Program surfaces for live video and music", async () => {
  const pc = createBrowserHarness({ mode: "pc", compositorEnabled: true, page: "overview" });
  await pc.context.setScene({ kind: "none" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pc.harness.preview.src, "/overlay/tester/compositor", "None on PC is the compositor's live WHEP video endpoint");

  const music = createBrowserHarness({ mode: "music", compositorEnabled: false, page: "overview" });
  await music.context.setScene({ kind: "none" });
  await new Promise(resolve => setImmediate(resolve));
  const noneUrl = music.harness.preview.src;
  assert.match(noneUrl, /^\/music-program\.html\?/);

  await music.context.setScene({ kind: "builtin", name: "startingSoon" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(music.harness.preview.src, noneUrl, "Music scene changes stay on one permanent browser surface");

  const parsed = new URL(noneUrl, "http://castnexus.local");
  assert.match(parsed.searchParams.get("music") || "", /\/overlay\/tester\/music\/profile-a/);
  assert.equal(parsed.searchParams.get("master"), "/overlay/tester/master");
});
