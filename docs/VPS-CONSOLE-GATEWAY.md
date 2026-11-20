# CastNexus VPS / Public Console Gateway

CastNexus can capture a console stream from a **different internet connection** by running its DNS, MediaMTX and dashboard on a VPS.

This is different from the Raspberry Pi / LAN interceptor:

- **LAN mode** uses ARP spoofing + DNAT because the console and CastNexus host share the same Ethernet network.
- **VPS mode** cannot use ARP. Instead, the console is configured to use the VPS as its DNS server. For Twitch plain-RTMP ingest hostnames, CastNexus DNS returns the VPS public IP. The console therefore connects directly to MediaMTX on the VPS.

## Important protocol limitation

VPS DNS redirection supports **plain RTMP on TCP/1935**.

It cannot transparently impersonate Twitch **RTMPS/TLS**. If a console/platform chooses RTMPS, redirecting the hostname to CastNexus would present the wrong TLS certificate. CastNexus intentionally does not attempt to bypass or forge that trust relationship.

## Data flow

```text
Console at home
   |
   | DNS UDP/TCP 53
   v
CastNexus VPS DNS
   |
   | Twitch ingest A -> VPS_PUBLIC_IP
   | Twitch ingest AAAA -> CastNexus IPv6, or NODATA if IPv4-only
   v
Console opens RTMP TCP/1935 to VPS
   |
   v
MediaMTX app/<real Twitch stream key>
   |
   v
CastNexus matches the authenticated Twitch account + selected Console profile
   |
   v
public/<twitch-login>
   |
   +--> Twitch
   +--> YouTube
   +--> other per-profile RTMP/SRT destinations
```

The console can be on a home network while CastNexus runs in a datacenter/VPS. `TARGET_IPS` and `GATEWAY_IP` are not used in VPS mode.

## Security model

Do **not** run a public recursive DNS server or an unrestricted RTMP listener by accident.

Set `VPS_ALLOWED_CLIENTS` to the **public/WAN IP of the internet connection where the console is located**. Do not put the console's `192.168.x.x` address here.

Example:

```dotenv
PUBLIC_IP=203.0.113.55
VPS_ALLOWED_CLIENTS=198.51.100.27/32
VPS_ALLOW_ANY=false
```

Multiple addresses/CIDRs can be comma-separated:

```dotenv
VPS_ALLOWED_CLIENTS=198.51.100.27/32,203.0.113.0/28
```

`VPS_ALLOW_ANY=true` is available only as an explicit opt-in. It is not recommended for normal installs.

The DNS service applies the same allow-list before doing recursion. The intercept container installs a TCP/1935 input firewall chain that:

1. always allows `127.0.0.0/8` so CastNexus internal RTMP still works;
2. allows `VPS_ALLOWED_CLIENTS`; and
3. drops other public clients from TCP/1935.

If you use an external firewall such as UFW, nftables, a cloud security group, or provider firewall, also restrict inbound traffic there.

## Required public ports

From the console's WAN IP to the VPS:

| Port | Protocol | Purpose |
| --- | --- | --- |
| 53 | UDP | Console DNS queries |
| 53 | TCP | DNS fallback / larger responses |
| 1935 | TCP | Plain RTMP console ingest |

The Studio/dashboard port should normally be placed behind HTTPS/reverse proxy or otherwise restricted. MediaMTX playback ports such as 8554/8888/8889/8890 do not need to be public just to capture a console and should be firewalled unless you intentionally use them remotely.

## Docker Compose

Use the normal Compose file plus the VPS override:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.vps.yml \
  --profile vps-console \
  up -d
```

Recommended `.env` values:

```dotenv
CASTNEXUS_IMAGE_TAG=beta
CASTNEXUS_CHANNEL=beta

# The VPS address used by CastNexus/Studio.
PI_IP=203.0.113.55

# Public address returned to the console for Twitch ingest DNS.
PUBLIC_IP=203.0.113.55
# Optional when the VPS has a routed public IPv6:
PUBLIC_IPV6=

# HOME WAN address where the console lives.
VPS_ALLOWED_CLIENTS=198.51.100.27/32
VPS_ALLOW_ANY=false

DNS_UPSTREAM=1.1.1.1
DNS_LOG_ALL=true

INTERCEPT_MODE=vps
VPS_RTMP_PORT=1935
VPS_RTMP_WAIT_SECONDS=60
```

`docker-compose.vps.yml` automatically sets the DNS service to public/VPS mode and redirects Twitch ingest names to `PUBLIC_IP`.

## Configure the console

On the console network settings:

1. keep the normal IP/gateway settings for the home network;
2. set the **primary DNS** to the CastNexus VPS public IPv4;
3. avoid a secondary public DNS resolver while testing, because the console may choose it and bypass CastNexus DNS;
4. start a Twitch broadcast from the console.

The console still uses its normal Twitch account and stream key. CastNexus already identifies a Console-profile source by the final stream-key segment of the incoming MediaMTX path.

## Verify DNS from another machine

From an allowed public IP:

```bash
dig @203.0.113.55 live.twitch.tv A
```

The answer should be the CastNexus VPS public IP.

For an IPv4-only VPS:

```bash
dig @203.0.113.55 live.twitch.tv AAAA
```

The response should contain no AAAA answer. This prevents a dual-stack console from receiving Twitch's real IPv6 ingest address and bypassing CastNexus.

## Verify MediaMTX

On the VPS:

```bash
curl -s http://127.0.0.1:9997/v3/paths/list | jq -r '.items[] | select(.ready == true) | .name'
```

When the console starts a compatible RTMP broadcast, you should see its incoming path and then the CastNexus public program path.

Typical sequence:

```text
app/<twitch-stream-key>
public/<twitch-login>
```

The exact app name is not relied on for account ownership; CastNexus matches the final stream-key segment and requires the account's active profile to be a Console profile.

## Logs

DNS:

```bash
docker compose logs -f dns
```

Expected redirect example:

```text
[console] 198.51.100.27 TWITCH REDIRECT A live-lhr.twitch.tv -> 203.0.113.55
```

VPS interceptor:

```bash
docker compose logs -f intercept
```

Expected startup:

```text
[intercept] VPS/public mode: console DNS should resolve Twitch ingest to this server; no ARP spoofing or gateway IP is used
[intercept] VPS RTMP allow 198.51.100.27/32
[intercept] VPS/public console RTMP gateway active on TCP/1935
```

## Dynamic home IPs

If the console's home WAN IP changes, update `VPS_ALLOWED_CLIENTS` and recreate the DNS/intercept services:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.vps.yml \
  --profile vps-console \
  up -d --force-recreate dns intercept
```

A future enhancement can automate dynamic-IP allow-list updates, but the secure default is to require an explicit trusted source range.
