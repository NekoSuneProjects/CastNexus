"use strict";

const dgram = require("node:dgram");
const net = require("node:net");
const dnsPacket = require("dns-packet");

function boolEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeAddress(value) {
  const text = String(value || "").trim();
  return text.startsWith("::ffff:") ? text.slice(7) : text;
}

function ipv4ToInt(value) {
  const parts = normalizeAddress(value).split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function parseAllowedClients(value) {
  return String(value || "").split(/[\s,]+/).map(v => v.trim()).filter(Boolean);
}

function addressMatchesRule(address, rule) {
  const client = normalizeAddress(address);
  const target = String(rule || "").trim();
  if (!target) return false;
  if (!target.includes("/")) return client === normalizeAddress(target);

  const [network, prefixText] = target.split("/");
  const prefix = Number(prefixText);
  if (net.isIP(client) !== 4 || net.isIP(network) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const clientInt = ipv4ToInt(client);
  const networkInt = ipv4ToInt(network);
  if (clientInt == null || networkInt == null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (clientInt & mask) === (networkInt & mask);
}

function isClientAllowed(address, { publicMode = false, allowAny = false, allowedClients = [] } = {}) {
  if (!publicMode) return true;
  if (allowAny) return true;
  return allowedClients.some(rule => addressMatchesRule(address, rule));
}

function serviceFor(name) {
  const n = String(name || "").replace(/\.$/, "").toLowerCase();
  if (/^live.*\.twitch\.tv$/i.test(n) ||
      /^[^.]+\.contribute\.live-video\.net$/i.test(n) ||
      /^[^.]+\.global-contribute\.live-video\.net$/i.test(n)) return "TWITCH";
  return null;
}

function responseFlags() {
  return dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE;
}

function buildHijackResponse(message, { redirectIpv4, redirectIpv6 } = {}) {
  const question = message.questions?.[0];
  if (!question) return null;
  const service = serviceFor(question.name);
  if (!service) return null;

  const answers = [];
  if (question.type === "A" && redirectIpv4) {
    answers.push({ type:"A", name:question.name, ttl:5, data:redirectIpv4 });
  } else if (question.type === "AAAA" && redirectIpv6) {
    answers.push({ type:"AAAA", name:question.name, ttl:5, data:redirectIpv6 });
  } else if (question.type !== "A" && question.type !== "AAAA") {
    return null;
  }

  // An intercepted Twitch AAAA query with no CastNexus public IPv6 address
  // deliberately receives NODATA. Returning Twitch's real AAAA result would
  // let a dual-stack console bypass the redirected IPv4 RTMP endpoint.
  return dnsPacket.encode({
    type:"response",
    id:message.id,
    flags:responseFlags(),
    questions:message.questions,
    answers,
  });
}

function frameTcpDns(payload) {
  const frame = Buffer.allocUnsafe(payload.length + 2);
  frame.writeUInt16BE(payload.length, 0);
  payload.copy(frame, 2);
  return frame;
}

function createRuntimeConfig(env = process.env) {
  const publicMode = boolEnv(env.DNS_PUBLIC_MODE, false) || ["vps", "public"].includes(String(env.DNS_MODE || "").toLowerCase());
  const allowAny = boolEnv(env.DNS_ALLOW_ANY, false);
  const allowedClients = parseAllowedClients(env.DNS_ALLOWED_CLIENTS || env.VPS_ALLOWED_CLIENTS);
  const redirectIpv4 = env.DNS_REDIRECT_IP || env.PUBLIC_IP || env.PI_IP || "";
  const redirectIpv6 = env.DNS_REDIRECT_IPV6 || env.PUBLIC_IPV6 || "";
  return {
    listen:env.DNS_LISTEN || "0.0.0.0",
    port:Number(env.DNS_PORT || 53),
    redirectIpv4,
    redirectIpv6,
    upstream:env.DNS_UPSTREAM || "1.1.1.1",
    upstreamPort:Number(env.DNS_UPSTREAM_PORT || 53),
    upstreamTimeoutMs:Math.max(250, Number(env.DNS_UPSTREAM_TIMEOUT_MS || 2500)),
    logAll:boolEnv(env.DNS_LOG_ALL, true),
    publicMode,
    allowAny,
    allowedClients,
  };
}

function validateRuntimeConfig(config) {
  if (!config.redirectIpv4) throw new Error("DNS_REDIRECT_IP, PUBLIC_IP, or PI_IP is required");
  if (net.isIP(config.redirectIpv4) !== 4) throw new Error(`DNS redirect IPv4 is invalid: ${config.redirectIpv4}`);
  if (config.redirectIpv6 && net.isIP(config.redirectIpv6) !== 6) throw new Error(`DNS redirect IPv6 is invalid: ${config.redirectIpv6}`);
  if (config.publicMode && !config.allowAny && config.allowedClients.length === 0) {
    throw new Error("public/VPS DNS mode requires DNS_ALLOWED_CLIENTS (recommended) or explicit DNS_ALLOW_ANY=true");
  }
}

function createForwarders(config) {
  function udp(query, callback) {
    const upstream = dgram.createSocket("udp4");
    let done = false;
    const finish = (error, response) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { upstream.close(); } catch {}
      callback(error, response);
    };
    const timer = setTimeout(() => finish(new Error("upstream UDP timeout")), config.upstreamTimeoutMs);
    upstream.once("message", response => finish(null, response));
    upstream.once("error", error => finish(error));
    upstream.send(query, config.upstreamPort, config.upstream, error => { if (error) finish(error); });
  }

  function tcp(query, callback) {
    let socket;
    let pending = Buffer.alloc(0);
    let done = false;
    const finish = (error, response) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      callback(error, response);
    };
    const timer = setTimeout(() => finish(new Error("upstream TCP timeout")), config.upstreamTimeoutMs);
    socket = net.createConnection({ host:config.upstream, port:config.upstreamPort }, () => socket.write(frameTcpDns(query)));
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 2) return;
      const length = pending.readUInt16BE(0);
      if (pending.length >= length + 2) finish(null, pending.subarray(2, length + 2));
    });
    socket.once("error", error => finish(error));
  }

  return { udp, tcp };
}

function startServer(env = process.env) {
  const config = createRuntimeConfig(env);
  validateRuntimeConfig(config);
  const forward = createForwarders(config);
  const udpServer = dgram.createSocket("udp4");

  function processQuery(buffer, client, transport, send) {
    const clientAddress = normalizeAddress(client.address);
    if (!isClientAllowed(clientAddress, config)) {
      console.warn(`[dns] blocked ${transport.toUpperCase()} query from ${clientAddress || "unknown"}`);
      return false;
    }

    let message;
    try { message = dnsPacket.decode(buffer); }
    catch (error) { console.error("[dns] invalid packet:", error.message); return true; }

    const question = message.questions?.[0];
    const name = question?.name || "unknown";
    const type = question?.type || "?";
    const service = question ? serviceFor(name) : null;
    const localResponse = buildHijackResponse(message, config);

    if (localResponse) {
      const target = type === "AAAA" ? (config.redirectIpv6 || "NODATA/IPv4-only") : config.redirectIpv4;
      console.log(`[console] ${clientAddress} ${service} REDIRECT ${type} ${name} -> ${target}`);
      send(localResponse);
      return true;
    }

    if (config.logAll && question) console.log(`[console] ${clientAddress} DNS ${type} ${name}`);
    forward[transport](buffer, (error, response) => {
      if (error) return console.error(`[dns] upstream ${transport}: ${error.message}`);
      send(response);
    });
    return true;
  }

  udpServer.on("message", (buffer, rinfo) => {
    processQuery(buffer, rinfo, "udp", response => udpServer.send(response, rinfo.port, rinfo.address));
  });
  udpServer.on("error", error => console.error("[dns] UDP:", error.message));

  const tcpServer = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    const client = { address:socket.remoteAddress, port:socket.remotePort };
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const length = pending.readUInt16BE(0);
        if (pending.length < length + 2) break;
        const query = pending.subarray(2, length + 2);
        pending = pending.subarray(length + 2);
        const accepted = processQuery(query, client, "tcp", response => {
          if (!socket.destroyed) socket.write(frameTcpDns(response));
        });
        if (!accepted) return socket.destroy();
      }
    });
    socket.on("error", () => {});
  });

  udpServer.bind(config.port, config.listen, () => {
    console.log(`[dns] UDP listening on ${config.listen}:${config.port}`);
    console.log(`[dns] upstream ${config.upstream}:${config.upstreamPort}`);
    console.log(`[dns] Twitch DNS routing target ${config.redirectIpv4}${config.redirectIpv6 ? ` / ${config.redirectIpv6}` : ""}`);
    if (config.publicMode) console.log(`[dns] VPS/public mode ACL ${config.allowAny ? "ANY (explicitly enabled)" : config.allowedClients.join(", ")}`);
  });
  tcpServer.listen(config.port, config.listen, () => console.log(`[dns] TCP listening on ${config.listen}:${config.port}`));

  return { udpServer, tcpServer, config };
}

if (require.main === module) {
  try { startServer(); }
  catch (error) {
    console.error(`[dns] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  boolEnv,
  normalizeAddress,
  parseAllowedClients,
  addressMatchesRule,
  isClientAllowed,
  serviceFor,
  buildHijackResponse,
  createRuntimeConfig,
  validateRuntimeConfig,
  startServer,
};
