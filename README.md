# CastNexus relaystream

A public relay for self-hosted CastNexus installs (Docker/dashboard, Desktop,
CLI) that sit behind NAT with no open inbound ports. A node pushes its live
feed out to relaystream over RTMP or WHIP; relaystream then serves it publicly
under `https://castnexus.nekosunevr.co.uk/relay/<nodeId>` (HLS/WHEP) so
viewers - and VRChat world video players - can watch without the source
install ever accepting an inbound connection.

Each pushing node authenticates with a short-lived signed push token obtained
from `POST /v1/nodes/register`, tied to that install's own persistent node ID
(generated once, stored locally, never changes unless the install is fully
reset). relaystream's admin API can list currently-registered/live nodes and
ban a node's ID, which immediately blocks new publishes from it.

See [`docs/RELAYSTREAM.md`](docs/RELAYSTREAM.md) for the full design, API
surface and security properties.

## Running it

```bash
cp .env.example .env
# fill in RELAYSTREAM_SIGNING_SECRET, RELAYSTREAM_ADMIN_TOKEN, and your public URL
docker compose up -d
```

## Development

```bash
cd relaystream
npm install
npm test
```
