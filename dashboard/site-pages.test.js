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

test("homepage advertises the whitelisted Discord Activity with the app link", () => {
  const html = homePage();
  assert.match(html, /id="discord-activity"/);
  assert.ok(html.includes('href="https://discord.com/oauth2/authorize?client_id=1573433224997113937"'));
  assert.match(html, /WHITELISTED ONLY FOR NOW/);
  assert.match(html, /<strong>30 slots<\/strong>/);
  assert.match(html, /<strong>30 days<\/strong>/);
  assert.match(html, /href="\/#discord-activity"/);
});

test("homepage says Discord Activity is cloud-only and invites ideas / bug reports", () => {
  const html = homePage();
  assert.match(html, /Not included in the Desktop app/);
  assert.match(html, /CastNexus cloud service/);
  assert.match(html, /id="feedback"/);
  assert.ok(html.includes('href="https://github.com/NekoSuneProjects/CastNexus/issues"'));
  assert.match(html, /Bugs &amp; issues/);
});

test("homepage download section offers Beta and Stable desktop, CLI and Docker", () => {
  const html = homePage();
  assert.match(html, /id="download"/);
  for (const channel of ["beta", "stable"]) assert.match(html, new RegExp(`data-channel="${channel}"`));
  for (const asset of ["win-setup", "win-portable", "linux-appimage", "linux-deb", "cli-win", "cli-linux"]) assert.equal(html.split(`data-asset="${asset}"`).length - 1, 2, asset);
  assert.match(html, /CASTNEXUS_IMAGE_TAG=beta/);
  assert.match(html, /CASTNEXUS_IMAGE_TAG=latest/);
  assert.match(html, /api\.github\.com\/repos\/" \+ REPO \+ "\/releases/);
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
  assert.doesNotThrow(() => new Function(script), "inline release script must parse");
  assert.ok(script.includes(String.raw`/setup.*\.exe$/i`), "regex backslashes survive the template literal");
});
