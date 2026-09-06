# CastNexus dns

A small standalone DNS-capture helper used for LAN and VPS console
broadcasting workflows. It selectively redirects a console's DNS lookups for
specific platform ingest hostnames so the console publishes its stream to a
CastNexus host instead of directly to the platform.

See [`docs/VPS-CONSOLE-GATEWAY.md`](docs/VPS-CONSOLE-GATEWAY.md) for how this
is used in the VPS/public console gateway workflow.

## Running it

```bash
cp .env.example .env
docker compose up -d
```

## Development

```bash
cd dns
npm install
npm test
```
