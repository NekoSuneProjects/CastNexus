"use strict";

// Reports dashboard page problems to the server log (`docker logs
// castnexus-dashboard` shows them as [client] lines): uncaught errors, failed
// promises, and a page that has not finished loading after 15 s together with
// the requests still pending at that moment. Loaded first, before the app.
(function installCastNexusDiagnostics() {
  const pending = new Map();
  let seq = 0, sent = 0;

  function report(kind, detail) {
    if (sent++ > 15) return;
    const text = `${kind} · ${location.pathname} · ${detail} · ${navigator.userAgent.slice(0, 120)}`;
    try {
      if (!navigator.sendBeacon?.("/api/client-log", new Blob([text], { type:"text/plain" }))) {
        fetch("/api/client-log", { method:"POST", body:text, keepalive:true }).catch(() => {});
      }
    } catch {}
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = function trackedFetch(input, init) {
    const id = ++seq;
    const url = String(typeof input === "string" ? input : input?.url || "").replace(location.origin, "");
    if (!url.includes("/api/client-log")) pending.set(id, { url, at:Date.now() });
    return realFetch(input, init).finally(() => pending.delete(id));
  };

  window.addEventListener("error", event => {
    const where = event.filename ? ` @ ${String(event.filename).replace(location.origin, "")}:${event.lineno}:${event.colno}` : "";
    report("error", `${event.message || event.error || "script error"}${where}`);
  });
  window.addEventListener("unhandledrejection", event => {
    const reason = event.reason;
    report("unhandledrejection", String(reason?.stack || reason?.message || reason).slice(0, 600));
  });

  function viewState() {
    const visible = ["login-view", "setup-view", "streamkey-view", "app-view"].filter(id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains("hidden");
    });
    return visible.join(",") || "none";
  }

  setTimeout(() => {
    const view = viewState();
    const content = document.getElementById("page-content");
    const empty = !content || !content.children.length;
    if (view === "none" || (view === "app-view" && empty)) {
      const waiting = [...pending.values()].map(p => `${p.url} (${Math.round((Date.now() - p.at) / 1000)}s)`).join(", ") || "none";
      report("stuck", `page not ready after 15s: visible view=${view}, content ${empty ? "empty" : "rendered"}, pending requests: ${waiting}, build=${window.CASTNEXUS_BUILD?.version || "?"}`);
    }
  }, 15000);
})();
