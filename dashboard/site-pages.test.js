"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { homePage, loginPage, privacyPage, termsPage } = require("./site-pages");

test("public homepage represents the open-source CastNexus product", () => {
  const html = homePage();
  for (const text of ["Your broadcast", "PC streaming", "Console capture", "Music 24/7", "Multi-destination", "Overlay Studio", "Reruns and recordings", "Docker, Desktop or CLI", "Open source by design"]) assert.match(html, new RegExp(text, "i"));
  assert.match(html, /href="\/login"/);
  assert.match(html, /github\.com\/NekoSuneProjects\/CastNexus/);
});

test("login and legal pages use root site routes", () => {
  const login = loginPage(), privacy = privacyPage(), terms = termsPage();
  assert.match(login, /href="\/auth\/twitch"/);
  assert.match(login, /href="\/privacy"/);
  assert.doesNotMatch(login + privacy + terms, /href="\/oauth\/(privacy|terms)/);
  assert.match(privacy, /UK data-protection law/);
  assert.match(privacy, /youtube\.upload/);
  assert.match(terms, /laws of England and Wales/);
});
