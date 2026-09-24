// Minimal per-account Server-Sent Events bus - the same mechanism CacheStream
// uses for its live chat/alert overlays (an in-process EventEmitter behind an
// SSE stream, see apps/web/src/lib/bus.ts + sse.ts), sized down for a
// single-process dashboard: no cross-instance fan-out needed here.

const clients = new Map(); // accountId -> Set<ServerResponse>

function subscribe(accountId, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  let set = clients.get(accountId);
  if (!set) { set = new Set(); clients.set(accountId, set); }
  set.add(res);

  req.on("close", () => {
    set.delete(res);
    if (set.size === 0) clients.delete(accountId);
  });
}

// In-process listeners (Music 24/7 worker, compositors). They receive the same
// events as SSE clients, without a loopback HTTP poll.
const listeners = new Map(); // accountId -> Set<fn>

function on(accountId, listener) {
  const key = String(accountId);
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

function publish(accountId, event) {
  for (const listener of listeners.get(String(accountId)) || []) {
    try { listener(event); } catch {}
  }
  const set = clients.get(accountId);
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) res.write(payload);
}

function clientCount(accountId) {
  return clients.get(accountId)?.size || 0;
}

// Keepalive comments so idle connections don't get closed by an intermediate
// proxy (e.g. Nginx Proxy Manager) - CacheStream's own SSE helper does the
// same thing every 25s.
setInterval(() => {
  for (const set of clients.values()) {
    for (const res of set) res.write(": ping\n\n");
  }
}, 25000).unref?.();

module.exports = { subscribe, publish, on, clientCount };
