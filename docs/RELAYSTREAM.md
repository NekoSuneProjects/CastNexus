# relaystream

relaystream lets a self-hosted CastNexus install (Docker/dashboard, Desktop,
or CLI) go public without opening any inbound ports. Instead of viewers
connecting in to the install, the install pushes its live feed *out* to
relaystream, which re-serves it publicly.

## Components

- **relaystream-mediamtx** - a stock `bluenviron/mediamtx:1.19.2` instance.
  Accepts RTMP push at `push/<nodeId>` and WHIP push at `whip/<nodeId>`, and
  serves playback of either as HLS/WHEP under the same path. WHIP support
  also lets VRChat world video players consume the resulting stream via
  WHEP/HLS like any other viewer.
- **relaystream-api** - a small Express app (`server.js`) that:
  - issues short-lived signed push tokens to registered node IDs
    (`POST /v1/nodes/register`),
  - is called by MediaMTX's `authHTTPAddress` webhook (`POST /mtx-auth`) on
    every publish/read attempt, and rejects publishes without a valid,
    unexpired token for that path's node ID, or from a banned node,
  - exposes an admin API (`GET /v1/admin/nodes`,
    `POST /v1/admin/nodes/:id/ban`, `POST /v1/admin/nodes/:id/unban`) gated by
    a bearer `RELAYSTREAM_ADMIN_TOKEN`.

MediaMTX has no built-in authentication configured anywhere else in
CastNexus, but relaystream is the one service that accepts connections from
the open internet, so access control has to be enforced at the media-server
boundary itself (before any RTMP/WHIP bytes are accepted), not only in an app
layer behind it.

## Node identity

Each pushing install generates a persistent node ID once (a UUID), stores it
locally, and reuses it for the lifetime of the install - it only changes if
the install's local state is fully wiped (factory reset/reinstall). The node
ID is not a secret; the push token obtained from `/v1/nodes/register` is
what actually authorizes publishing, and tokens are short-lived and
re-fetched periodically.

## Push flow

1. The local install calls `POST /v1/nodes/register` with its node ID and
   receives a signed push token plus the RTMP/WHIP ingest URLs and the public
   watch URL for that node.
2. It starts an outbound push (RTMP or WHIP) to
   `push/<nodeId>` / `whip/<nodeId>`, with the token attached as a query
   parameter or bearer header.
3. MediaMTX calls `/mtx-auth` on the attempt; relaystream-api validates the
   token and node-ban status before allowing the publish.
4. Viewers hit the public URL, which is reverse-proxied to relaystream's
   HLS/WHEP playback for that same path - no token required to watch.

## Admin: listing and banning nodes

`GET /v1/admin/nodes` returns every node relaystream has ever seen a
`register` call from, each node's ban status, and whether it is currently
live (cross-checked against MediaMTX's Control API,
`GET /v3/paths/list`). `POST /v1/admin/nodes/:id/ban` immediately blocks that
node ID from registering or publishing; `.../unban` reverses it.

## Deployment

relaystream is deployed the same way as `oauth-broker`: a Docker Compose
stack with both services bound to `127.0.0.1` only, fronted by the existing
reverse proxy in front of `castnexus.nekosunevr.co.uk`. See
[`docker-compose.yml`](../docker-compose.yml) and
[`.env.example`](../.env.example).

Suggested Nginx routing:

```
location /whip/         { proxy_pass http://127.0.0.1:8189; }
location /relay/        { proxy_pass http://127.0.0.1:8888; } # HLS playback
location /v1/nodes/register { proxy_pass http://127.0.0.1:8092; }
```

RTMP push (port 1936) does not go through Nginx - it is a raw TCP protocol,
so it should be exposed directly (or via a TCP-mode proxy) rather than the
HTTPS virtual host.
