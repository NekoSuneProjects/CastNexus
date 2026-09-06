# CastNexus intercept

A small standalone console-capture helper. In LAN mode it uses ARP spoofing +
DNAT so a console on the same Ethernet network routes its broadcast traffic
through the CastNexus host. In VPS mode it runs a plain-RTMP-only public
listener with a strict client allow-list.

See [`docs/VPS-CONSOLE-GATEWAY.md`](docs/VPS-CONSOLE-GATEWAY.md) for the VPS
workflow this pairs with (alongside the `dns` service).

## Running it

```bash
cp .env.example .env
docker compose --profile console up -d
```
