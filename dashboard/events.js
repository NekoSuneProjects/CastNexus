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

function publish(accountId, event) {
  const set = clients.get(accountId);
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) res.write(payload);
}

// Keepalive comments so idle connections don't get closed by an intermediate
// proxy (e.g. Nginx Proxy Manager) - CacheStream's own SSE helper does the
// same thing every 25s.
setInterval(() => {
  for (const set of clients.values()) {
    for (const res of set) res.write(": ping\n\n");
  }
}, 25000);

module.exports = { subscribe, publish };
