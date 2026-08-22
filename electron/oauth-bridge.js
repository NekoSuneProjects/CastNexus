"use strict";

// External-browser OAuth bridge.
//
// The dashboard's OAuth flow is session-cookie based: GET /auth/<provider>
// stores `oauthState` on the Express session and redirects to the provider;
// GET /auth/<provider>/callback validates that state and writes `accountId`
// back onto the same session. That means whichever browser completes the
// callback is the one that ends up logged in.
//
// Opening the provider in the system browser therefore cannot use the
// dashboard's own callback URL — the browser would win the session and the
// Electron window would stay logged out. Instead:
//
//   1. Electron asks the dashboard for the authorize URL *through the app
//      window's session*, so the oauthState cookie lands in Electron's jar.
//   2. Electron opens that URL with shell.openExternal.
//   3. The provider redirects the system browser to this module's own loopback
//      server (dashboard port + 1), which just captures ?code&state and shows
//      a "you can close this tab" page.
//   4. Electron replays the code to the dashboard's real callback route using
//      the app window's session, so the cookie state matches and accountId is
//      written into Electron's jar.
//   5. The app window reloads, logged in.
//
// This keeps dashboard/server.js completely untouched.

const http = require("node:http");
const { shell, net } = require("electron");

const PROVIDERS = ["twitch", "youtube"];
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

let server = null;
let serverPort = 0;
const pending = new Map(); // state -> { provider, resolve, timer }

function callbackPath(provider) {
  return `/auth/${provider}/callback`;
}

function getCallbackPort(dashboardPort) {
  return Number(dashboardPort) + 1;
}

function getRedirectUri(provider, dashboardPort) {
  return `http://localhost:${getCallbackPort(dashboardPort)}${callbackPath(provider)}`;
}

function resultPage(title, message, tone) {
  const accent = tone === "error" ? "#ff667a" : "#7c5cff";
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title><style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    background:linear-gradient(180deg,#080a12,#060810 70%);color:#f4f6ff;}
  .card{max-width:460px;padding:40px;border-radius:24px;text-align:center;
    background:linear-gradient(180deg,rgba(20,24,40,.82),rgba(12,15,27,.76));
    border:1px solid rgba(255,255,255,.085);box-shadow:0 24px 70px rgba(0,0,0,.42);}
  h1{font-size:22px;margin:0 0 10px;color:${accent};}
  p{margin:0;font-size:14px;color:#a7b0c5;line-height:1.6;}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function startCallbackServer(dashboardPort) {
  if (server) return Promise.resolve(serverPort);
  const port = getCallbackPort(dashboardPort);

  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, `http://localhost:${port}`);
      } catch {
        res.writeHead(400).end();
        return;
      }

      const provider = PROVIDERS.find(p => url.pathname === callbackPath(p));
      if (!provider) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(resultPage("Not found", "This address is not part of the sign-in flow.", "error"));
        return;
      }

      const state = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";
      const error = url.searchParams.get("error_description") || url.searchParams.get("error") || "";
      const entry = pending.get(state);

      res.writeHead(error || !entry ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
      if (error) {
        res.end(resultPage("Sign-in failed", error, "error"));
      } else if (!entry) {
        res.end(resultPage("Sign-in expired", "This sign-in link is no longer valid. Start again from CastNexus Studio.", "error"));
      } else {
        res.end(resultPage("You're signed in", "CastNexus Studio has been connected. You can close this tab and return to the app."));
      }

      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(state);
      entry.resolve({ provider: entry.provider, code, state, error });
    });

    server.on("error", err => {
      server = null;
      reject(new Error(`OAuth callback server could not bind to port ${port}: ${err.message}`));
    });

    server.listen(port, "127.0.0.1", () => {
      serverPort = port;
      console.log(`[oauth] callback server listening on http://localhost:${port}`);
      resolve(port);
    });
  });
}

function stopCallbackServer() {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  try { server?.close(); } catch {}
  server = null;
}

// Issues a request through the given Electron session so its cookie jar is
// used and updated. Redirects are captured rather than followed.
function sessionRequest(url, session) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: "GET", url, session, redirect: "manual", useSessionCookies: true });
    request.on("redirect", (statusCode, _method, redirectUrl) => {
      request.abort();
      resolve({ statusCode, location: redirectUrl, body: "" });
    });
    request.on("response", response => {
      let body = "";
      response.on("data", chunk => { body += chunk.toString(); });
      response.on("end", () => resolve({ statusCode: response.statusCode, location: null, body }));
      response.on("error", reject);
    });
    request.on("error", err => {
      // abort() after a redirect surfaces here on some platforms; ignore it,
      // the redirect handler has already resolved the promise.
      if (/aborted/i.test(err.message)) return;
      reject(err);
    });
    request.end();
  });
}

/**
 * Runs the whole external-browser sign-in for one provider.
 * Resolves true when the app window's session is authenticated.
 */
async function beginLogin(provider, { dashboardPort, session }) {
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown OAuth provider: ${provider}`);
  await startCallbackServer(dashboardPort);

  const base = `http://localhost:${dashboardPort}`;
  const start = await sessionRequest(`${base}/auth/${provider}`, session);

  if (!start.location) {
    const detail = start.body?.trim().slice(0, 200) || `HTTP ${start.statusCode}`;
    throw new Error(`dashboard did not start the ${provider} flow: ${detail}`);
  }

  const authorizeUrl = new URL(start.location);
  const state = authorizeUrl.searchParams.get("state");
  if (!state) throw new Error(`${provider} authorize URL is missing the state parameter`);

  const captured = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(state);
      reject(new Error("sign-in timed out — the browser window was never completed"));
    }, FLOW_TIMEOUT_MS);
    pending.set(state, { provider, resolve, timer });
  });

  console.log(`[oauth] opening ${provider} sign-in in the system browser`);
  await shell.openExternal(authorizeUrl.toString());

  const result = await captured;
  if (result.error) throw new Error(result.error);
  if (!result.code) throw new Error("no authorization code was returned");

  // Replay into the dashboard using the app's cookie jar so the session that
  // gets `accountId` is the one the Electron window actually uses.
  const finish = await sessionRequest(
    `${base}${callbackPath(provider)}?code=${encodeURIComponent(result.code)}&state=${encodeURIComponent(result.state)}`,
    session,
  );

  const ok = finish.location !== null || (finish.statusCode >= 200 && finish.statusCode < 300);
  if (!ok) {
    const detail = finish.body?.trim().slice(0, 200) || `HTTP ${finish.statusCode}`;
    throw new Error(`dashboard rejected the ${provider} callback: ${detail}`);
  }

  console.log(`[oauth] ${provider} sign-in complete`);
  return true;
}

/** True for URLs that start a dashboard OAuth flow. */
function matchProvider(url, dashboardPort) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const isDashboard =
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
    parsed.port === String(dashboardPort);
  if (!isDashboard) return null;
  return PROVIDERS.find(p => parsed.pathname === `/auth/${p}`) || null;
}

module.exports = {
  PROVIDERS,
  beginLogin,
  matchProvider,
  getRedirectUri,
  getCallbackPort,
  startCallbackServer,
  stopCallbackServer,
};
