"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const dnsPacket = require("dns-packet");
const {
  serviceFor,
  parseAllowedClients,
  addressMatchesRule,
  isClientAllowed,
  buildHijackResponse,
  createRuntimeConfig,
  validateRuntimeConfig,
} = require("./server");

test("recognizes Twitch console ingest hostnames", () => {
  assert.equal(serviceFor("live.twitch.tv"), "TWITCH");
  assert.equal(serviceFor("live-lhr.twitch.tv"), "TWITCH");
  assert.equal(serviceFor("abc.contribute.live-video.net"), "TWITCH");
  assert.equal(serviceFor("abc.global-contribute.live-video.net"), "TWITCH");
  assert.equal(serviceFor("www.twitch.tv"), null);
});

test("public DNS ACL accepts exact IPv4 and CIDR rules", () => {
  const rules = parseAllowedClients("203.0.113.7/32, 198.51.100.0/24");
  assert.equal(addressMatchesRule("::ffff:203.0.113.7", "203.0.113.7/32"), true);
  assert.equal(addressMatchesRule("198.51.100.44", "198.51.100.0/24"), true);
  assert.equal(addressMatchesRule("198.51.101.44", "198.51.100.0/24"), false);
  assert.equal(isClientAllowed("203.0.113.7", { publicMode:true, allowedClients:rules }), true);
  assert.equal(isClientAllowed("192.0.2.1", { publicMode:true, allowedClients:rules }), false);
  assert.equal(isClientAllowed("192.0.2.1", { publicMode:true, allowAny:true, allowedClients:[] }), true);
  assert.equal(isClientAllowed("192.0.2.1", { publicMode:false, allowedClients:[] }), true);
});

test("Twitch A queries redirect to CastNexus public IPv4", () => {
  const query = dnsPacket.decode(dnsPacket.encode({
    type:"query",
    id:1234,
    flags:dnsPacket.RECURSION_DESIRED,
    questions:[{ type:"A", name:"live-lhr.twitch.tv" }],
  }));
  const response = dnsPacket.decode(buildHijackResponse(query, { redirectIpv4:"203.0.113.55" }));
  assert.equal(response.answers.length, 1);
  assert.equal(response.answers[0].type, "A");
  assert.equal(response.answers[0].data, "203.0.113.55");
});

test("Twitch AAAA queries cannot bypass an IPv4-only CastNexus gateway", () => {
  const query = dnsPacket.decode(dnsPacket.encode({
    type:"query",
    id:1235,
    flags:dnsPacket.RECURSION_DESIRED,
    questions:[{ type:"AAAA", name:"abc.contribute.live-video.net" }],
  }));
  const response = dnsPacket.decode(buildHijackResponse(query, { redirectIpv4:"203.0.113.55" }));
  assert.equal(response.answers.length, 0, "IPv4-only gateway must return NODATA instead of Twitch's real AAAA address");
});

test("Twitch AAAA queries can redirect to a configured CastNexus IPv6", () => {
  const query = dnsPacket.decode(dnsPacket.encode({
    type:"query",
    id:1236,
    flags:dnsPacket.RECURSION_DESIRED,
    questions:[{ type:"AAAA", name:"abc.global-contribute.live-video.net" }],
  }));
  const response = dnsPacket.decode(buildHijackResponse(query, {
    redirectIpv4:"203.0.113.55",
    redirectIpv6:"2001:db8::55",
  }));
  assert.equal(response.answers.length, 1);
  assert.equal(response.answers[0].data, "2001:db8::55");
});

test("public mode refuses to start as an accidental open resolver", () => {
  const unsafe = createRuntimeConfig({
    DNS_PUBLIC_MODE:"true",
    DNS_REDIRECT_IP:"203.0.113.55",
  });
  assert.throws(() => validateRuntimeConfig(unsafe), /DNS_ALLOWED_CLIENTS/);

  const safe = createRuntimeConfig({
    DNS_PUBLIC_MODE:"true",
    DNS_REDIRECT_IP:"203.0.113.55",
    DNS_ALLOWED_CLIENTS:"203.0.113.7/32",
  });
  assert.doesNotThrow(() => validateRuntimeConfig(safe));
});
