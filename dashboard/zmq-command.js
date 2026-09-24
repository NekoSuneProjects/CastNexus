"use strict";

// Minimal ZeroMQ (ZMTP 3.0, NULL mechanism) REQ client, just enough to talk
// to FFmpeg's zmq/azmq filter: it binds a REP socket and accepts
// "<target> <command> <arg>" messages, replying "<code> <text>".
// Used to reposition/rescale the gameplay in a running program without
// restarting FFmpeg (which would drop every destination).

const net = require("node:net");

function frame(body, { more = false, command = false } = {}) {
  const long = body.length > 255;
  const head = Buffer.alloc(long ? 9 : 2);
  head[0] = (more ? 1 : 0) | (long ? 2 : 0) | (command ? 4 : 0);
  if (long) head.writeBigUInt64BE(BigInt(body.length), 1); else head[1] = body.length;
  return Buffer.concat([head, body]);
}

function greeting() {
  const g = Buffer.alloc(64);
  g[0] = 0xff; g[9] = 0x7f; g[10] = 3; g[11] = 0;
  g.write("NULL", 12, "ascii");
  return g;
}

function readyCommand() {
  const name = Buffer.from("Socket-Type"), value = Buffer.from("REQ");
  const len = Buffer.alloc(4); len.writeUInt32BE(value.length);
  return frame(Buffer.concat([Buffer.from([5]), Buffer.from("READY"), Buffer.from([name.length]), name, len, value]), { command:true });
}

class ZmqCommandClient {
  constructor({ host = "127.0.0.1", port, timeoutMs = 3000 } = {}) {
    this.host = host; this.port = port; this.timeoutMs = timeoutMs;
    this.socket = null; this.buffer = Buffer.alloc(0); this.stage = "closed";
    this.pending = null; this.queue = Promise.resolve(); this.parts = [];
  }

  _connect() {
    if (this.stage === "ready") return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.connect({ host:this.host, port:this.port });
      this.socket = socket; this.buffer = Buffer.alloc(0); this.stage = "greeting";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("zmq connect timeout")); }, this.timeoutMs);
      socket.on("connect", () => socket.write(greeting()));
      socket.on("data", chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.stage === "greeting" && this.buffer.length >= 64) {
          this.buffer = this.buffer.subarray(64); this.stage = "handshake"; socket.write(readyCommand());
        }
        this._drain(() => { clearTimeout(timer); this.stage = "ready"; resolve(); });
      });
      const fail = err => { clearTimeout(timer); this.stage = "closed"; this.connecting = null; if (this.pending) { this.pending.reject(err); this.pending = null; } reject(err); };
      socket.on("error", fail);
      socket.on("close", () => fail(new Error("zmq socket closed")));
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  _drain(onReady) {
    for (;;) {
      if (this.buffer.length < 2) return;
      const flags = this.buffer[0], long = flags & 2;
      const headLen = long ? 9 : 2;
      if (this.buffer.length < headLen) return;
      const size = long ? Number(this.buffer.readBigUInt64BE(1)) : this.buffer[1];
      if (this.buffer.length < headLen + size) return;
      const body = this.buffer.subarray(headLen, headLen + size);
      this.buffer = this.buffer.subarray(headLen + size);
      if (flags & 4) { if (this.stage === "handshake" && body.subarray(1, 6).toString() === "READY") onReady(); continue; }
      this.parts.push(body);
      if (!(flags & 1)) {
        const parts = this.parts; this.parts = [];
        const reply = parts.filter(p => p.length).map(p => p.toString()).join(" ");
        if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer); p.resolve(reply); }
      }
    }
  }

  // Resolves with FFmpeg's reply, e.g. "0 Success". Requests are serialised
  // (REQ/REP must alternate).
  send(message) {
    const run = async () => {
      await this._connect();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending = null; this.close(); reject(new Error("zmq reply timeout")); }, this.timeoutMs);
        this.pending = { resolve, reject, timer };
        this.socket.write(Buffer.concat([frame(Buffer.alloc(0), { more:true }), frame(Buffer.from(String(message)))]));
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  close() {
    try { this.socket?.destroy(); } catch {}
    this.socket = null; this.stage = "closed";
  }
}

// Escape a value for the zmq filter's bind_address option inside -filter_complex.
function bindAddressOption(port) {
  return `bind_address=tcp\\\\://127.0.0.1\\\\:${Number(port)}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

module.exports = { ZmqCommandClient, bindAddressOption, freePort };
