const dgram = require("node:dgram");
const dnsPacket = require("dns-packet");

const LISTEN = process.env.DNS_LISTEN || "0.0.0.0";
const PI_IP = process.env.PI_IP;
const UPSTREAM = process.env.DNS_UPSTREAM || "1.1.1.1";
const UPSTREAM_PORT = Number(process.env.DNS_UPSTREAM_PORT || 53);
const LOG_ALL = String(process.env.DNS_LOG_ALL || "true").toLowerCase() === "true";

if (!PI_IP) {
  console.error("PI_IP is required");
  process.exit(1);
}

const server = dgram.createSocket("udp4");

function serviceFor(name) {
  const n = name.replace(/\.$/, "").toLowerCase();

  if (/^live.*\.twitch\.tv$/i.test(n) ||
      /^[^.]+\.contribute\.live-video\.net$/i.test(n) ||
      /^[^.]+\.global-contribute\.live-video\.net$/i.test(n)) return "TWITCH";

  return null;
}

server.on("message", (buf, rinfo) => {
  let msg;
  try { msg = dnsPacket.decode(buf); }
  catch (e) { console.error("[dns] invalid packet:", e.message); return; }

  const q = msg.questions?.[0];
  const name = q?.name || "unknown";
  const type = q?.type || "?";
  const service = q && q.type === "A" ? serviceFor(name) : null;

  if (service) {
    try {
      const response = dnsPacket.encode({
        type: "response",
        id: msg.id,
        flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
        questions: msg.questions,
        answers: [{ type: "A", name: q.name, ttl: 5, data: PI_IP }]
      });

      console.log(`[ps5] ${rinfo.address} ${service} HIJACK ${type} ${name} -> ${PI_IP}`);
      server.send(response, rinfo.port, rinfo.address);
    } catch (e) {
      console.error(`[dns] failed to encode hijack response for ${name}:`, e.message);
    }
    return;
  }

  // Would this name have been hijacked if it were an A query? Flag it so an
  // AAAA (or any non-A) query bypassing the hijack is impossible to miss.
  const wouldHijack = q ? serviceFor(name) : null;
  if (wouldHijack && type !== "A") {
    console.log(`[ps5] ${rinfo.address} ${wouldHijack} BYPASS-WARNING ${type} ${name} not intercepted (only A queries are hijacked) — real IP will be returned`);
  }

  if (LOG_ALL && q) console.log(`[ps5] ${rinfo.address} DNS ${type} ${name}`);

  const upstream = dgram.createSocket("udp4");
  upstream.once("message", response => {
    server.send(response, rinfo.port, rinfo.address);
    upstream.close();
  });
  upstream.once("error", err => {
    console.error("[dns] upstream:", err.message);
    upstream.close();
  });
  upstream.send(buf, UPSTREAM_PORT, UPSTREAM);
});

server.on("listening", () => {
  console.log(`[dns] listening on ${LISTEN}:53`);
  console.log(`[dns] upstream ${UPSTREAM}:${UPSTREAM_PORT}`);
  console.log(`[dns] Twitch DNS routing target ${PI_IP}`);
});

server.bind(53, LISTEN);
