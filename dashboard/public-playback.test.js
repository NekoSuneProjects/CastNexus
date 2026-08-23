"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { publicBaseUrl, normalisePublicBase, playbackTargets, isDirectHostAddress, splitHost } = require("./public-playback");

const request = (headers, protocol = "http") => ({ headers, protocol, get:name => headers[name.toLowerCase()] });

test("a reverse-proxied domain keeps https and the external host", () => {
  const base = publicBaseUrl(request({
    host:"127.0.0.1:8090",
    "x-forwarded-host":"castnexus.nekosunevr.co.uk",
    "x-forwarded-proto":"https",
  }));
  assert.equal(base, "https://castnexus.nekosunevr.co.uk");
});

test("a chain of proxies uses the outermost hop", () => {
  const base = publicBaseUrl(request({
    host:"127.0.0.1:8090",
    "x-forwarded-host":"castnexus.example.com, inner.internal",
    "x-forwarded-proto":"https, http",
  }));
  assert.equal(base, "https://castnexus.example.com");
});

test("direct IP and localhost access stays on http with its port", () => {
  assert.equal(publicBaseUrl(request({ host:"192.168.1.10:8090" })), "http://192.168.1.10:8090");
  assert.equal(publicBaseUrl(request({ host:"localhost:8090" })), "http://localhost:8090");
  assert.equal(publicBaseUrl(request({ host:"[::1]:8090" })), "http://[::1]:8090");
});

test("a bare IP is never advertised as https even if the proxy claims it", () => {
  // An explicit forwarded proto is still honoured - somebody may genuinely
  // terminate TLS in front of an IP - but nothing infers https on its own.
  assert.equal(publicBaseUrl(request({ host:"10.0.0.5:8090" }, "https")), "http://10.0.0.5:8090");
  assert.equal(publicBaseUrl(request({ host:"10.0.0.5:8090", "x-forwarded-proto":"https" })), "https://10.0.0.5:8090");
});

test("an explicit public base url overrides everything the request says", () => {
  const base = publicBaseUrl(request({ host:"127.0.0.1:8090", "x-forwarded-host":"inner", "x-forwarded-proto":"http" }), { explicitBase:"https://castnexus.example.com/" });
  assert.equal(base, "https://castnexus.example.com");
});

test("explicit base urls are normalised and bad values rejected", () => {
  assert.equal(normalisePublicBase("castnexus.example.com"), "https://castnexus.example.com");
  assert.equal(normalisePublicBase("192.168.1.10:8090"), "http://192.168.1.10:8090");
  assert.equal(normalisePublicBase("https://example.com/castnexus/"), "https://example.com/castnexus");
  assert.equal(normalisePublicBase("   "), null);
  assert.equal(normalisePublicBase("https://"), null);
});

test("playback targets expose both LL-HLS and VRChat-compatible HLS", () => {
  const targets = playbackTargets({ base:"https://castnexus.example.com", safePath:"public/nekosunevr" });
  assert.equal(targets.hls, "https://castnexus.example.com/hls/public/nekosunevr/index.m3u8");
  assert.equal(targets.vrchatHls, "https://castnexus.example.com/vrchat-hls/public/nekosunevr/index.m3u8");
  assert.equal(targets.webPlayer, "https://castnexus.example.com/webrtc/public/nekosunevr");
  assert.equal(targets.whep, "https://castnexus.example.com/webrtc/public/nekosunevr/whep");
  assert.equal(targets.rtsp, "rtsp://castnexus.example.com:8554/public/nekosunevr");
  assert.equal(targets.srt, "srt://castnexus.example.com:8890?streamid=read:public/nekosunevr");
});

test("the VRChat MPEG-TS HLS url is presented first and normal HLS remains available", () => {
  const { links } = playbackTargets({ base:"http://192.168.1.10:8090", safePath:"public/nekosunevr" });
  assert.equal(links[0].key, "vrchatHls");
  assert.equal(links[0].primary, true);
  assert.match(links[0].label, /VRChat/);
  assert.match(links[0].protocol, /MPEG-TS/);
  assert.equal(links[0].url, "http://192.168.1.10:8090/vrchat-hls/public/nekosunevr/index.m3u8");

  const normal = links.find(link => link.key === "hls");
  assert.ok(normal);
  assert.equal(normal.url, "http://192.168.1.10:8090/hls/public/nekosunevr/index.m3u8");
  assert.match(normal.protocol, /LL-HLS/);

  for (const link of links) {
    assert.ok(link.label && !/^[a-z]+[A-Z]/.test(link.label), `${link.key} should not expose a raw API property name`);
    assert.ok(link.hint, `${link.key} should explain what it is for`);
  }
  assert.deepEqual(links.map(l => l.key), ["vrchatHls", "hls", "webPlayer", "whep", "rtsp", "srt"]);
});

test("RTSP/SRT can point at a separate media host when the dashboard is proxied", () => {
  const targets = playbackTargets({ base:"https://castnexus.example.com", safePath:"public/x", mediaHost:"203.0.113.9" });
  assert.equal(targets.rtsp, "rtsp://203.0.113.9:8554/public/x");
  assert.equal(targets.srt, "srt://203.0.113.9:8890?streamid=read:public/x");
});

test("host parsing and direct-address detection cover the deployment shapes", () => {
  assert.deepEqual(splitHost("example.com:8090"), { hostname:"example.com", port:"8090" });
  assert.deepEqual(splitHost("example.com"), { hostname:"example.com", port:"" });
  assert.equal(splitHost("[2001:db8::1]:8090").hostname, "2001:db8::1");
  assert.equal(isDirectHostAddress("192.168.1.10"), true);
  assert.equal(isDirectHostAddress("castnexus.local"), true);
  assert.equal(isDirectHostAddress("castnexus.nekosunevr.co.uk"), false);
});
