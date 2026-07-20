# NekoSune Restream Node

Take a broadcast and fan it out to your own RTMP/SRT destinations, managed
live from a web dashboard - instead of (or as well as) the real platform.
There are **two independent ways to get a stream in**, and each dashboard
account picks which one(s) it uses right after signing in - **console**, **PC
streaming software**, or **both**:

- **PC streaming software** - point OBS (or any RTMP-capable software) at
  this box like any normal RTMP target: a server URL + your stream key. No
  DNS or network tricks involved at all.
- **Console** (e.g. PS5) - the console's own **Create -> Broadcast ->
  Twitch** button, transparently captured via DNS hijack + ARP-spoof
  intercept, since a console can't be pointed at a custom RTMP server the
  way OBS can. Capture is Twitch-only (a console's native "Broadcast ->
  YouTube" can't be reliably intercepted, unlike Twitch) - but YouTube works
  fine as one of your *output* destinations either way, added like any
  other RTMP/SRT target from the dashboard.

Either way, once the feed lands here the rest is identical: the dashboard
matches it to your account by stream key, and pushes it out to whatever
destinations you've enabled. **Choosing "both" is genuinely just "both" -
console and PC are detected independently**, so the dashboard can show each
one's live status separately instead of one hiding the other. Only one
drives the actual output pushes at a time (most RTMP destinations only
accept one publisher per stream key anyway) - whichever goes live first,
with automatic failover to the other if it's still live when the first one
stops.

```text
PC software ──── rtmp://PI_IP:1935/live/<streamkey> ────────┐
                                                             │
Console ── (DNS hijack, ARP-spoofed, DNAT'd to :1935) ───────┤
                                                             ▼
                                    MediaMTX on the Raspberry Pi <- also
                                       serves the same feed back out as
                                       LL-HLS / RTSP / SRT / WHIP for direct
                                       playback (VRChat, VLC, OBS...)
                                                             │
                    Dashboard (auth + control) spawns one independent
                    ffmpeg push per enabled destination, sourced from
                    whichever of that account's sources is currently active
                      ├── Twitch RTMP
                      ├── Kick RTMP
                      ├── your own RTMP/SRT endpoint
                      └── ...any destination you add from the dashboard
```

Which **containers** run is a separate, infrastructure-level decision (not
per-account): set `TARGET_IPS`/`GATEWAY_IP` in `.env` if you have a console
to capture, and `./install.sh` brings up the `dns` + `intercept` containers
alongside `mediamtx` + `dashboard`. Leave them blank and only `mediamtx` +
`dashboard` start - PC/OBS sources push straight to `mediamtx` regardless,
no extra containers needed for that. Which source(s) an *individual account*
actually uses is chosen in the dashboard after signing in, independently of
what's running.

## Getting PC streaming software (OBS, etc.) connected - step by step

1. **Install and start the stack** (see below) - `TARGET_IPS` can be blank
   if you have no console to capture.
2. **Open the dashboard** at `http://<Pi LAN IP>:8090` and sign in with
   Twitch. On first login, paste your Twitch stream key (from
   `dashboard.twitch.tv/settings/stream`) and pick **PC streaming software**
   (or **Both**) as how you'll stream.
3. **Add at least one destination** (the "+ Add destination" button) - a
   full `rtmp://` or `srt://` URL including the stream key, and turn it on.
4. In the dashboard's **"Connect a source" -> "PC / software"** tab, copy
   the server URL (`rtmp://<Pi LAN IP>:1935/live`). In OBS: Settings ->
   Stream -> Service: Custom -> Server: that URL -> Stream Key: your Twitch
   stream key (the same one from step 2).
5. **Start streaming in OBS.** Watch the dashboard - the status badge should
   flip to "Live (PC)", the preview player should start playing, and your
   enabled destination(s) should show "Pushing now".
6. Stopping the stream in OBS automatically stops every destination -
   nothing to clean up (unless Console is also live for this account, in
   which case outputs fail over to it).

## Getting your console (e.g. PS5) connected - step by step

1. **Install and start the stack** (see below) with `TARGET_IPS`/`GATEWAY_IP`
   set to your console's IP and your LAN gateway.
2. **On the console:** Settings -> Network -> Settings -> Set Up Internet
   Connection -> [your connection] -> Advanced Settings -> set:
   ```text
   DNS Settings: Manual
   Primary DNS: <Raspberry Pi LAN IP>
   Secondary DNS: 0.0.0.0
   ```
   Save, and let it reconnect to the network.
3. **Open the dashboard** at `http://<Pi LAN IP>:8090` and sign in with
   Twitch. On first login, paste your Twitch stream key (from
   `dashboard.twitch.tv/settings/stream`) and pick **Console** (or **Both**)
   as how you'll stream - this is how an incoming broadcast gets matched to
   your account.
4. **Add at least one destination** (the "+ Add destination" button) - a
   full `rtmp://` or `srt://` URL including the stream key, and turn it on.
5. **On the console:** Create -> Broadcast -> Twitch. Wait for the live
   indicator with a running timer.
6. Watch the dashboard - the status badge should flip to "Live (console)",
   the preview player should start playing, and your enabled destination(s)
   should show "Pushing now".
7. Ending the broadcast automatically stops every destination - nothing to
   clean up (unless PC software is also live for this account, in which
   case outputs fail over to it).

Two independent layers try to catch the console's stream, because relying on
DNS alone turned out not to be reliable in practice:

1. **DNS hijack** (`dns/`) - answers Twitch ingest hostname lookups with
   the Pi's own IP. Only fires if the console does a fresh DNS lookup for
   the exact ingest host.
2. **ARP-spoof + DNAT intercept** (`intercept/`) - makes the Pi the man in
   the middle between the console and the LAN gateway, and transparently
   redirects any outbound TCP:1935 connection to the Pi's own RTMP
   listener, regardless of what IP/hostname the console actually used. This
   is what actually makes Twitch capture work reliably - DNS hijacking
   alone missed it because the real ingest address is often handed to the
   console directly by an HTTPS API call, not a fresh DNS lookup. (We tried
   this same approach for YouTube too - it never caught a single YouTube
   broadcast in testing, which is why capture is Twitch-only now.)

## Install (Raspberry Pi / Docker)

```bash
cp .env.example .env
nano .env   # set PI_IP, TWITCH_CLIENT_ID/SECRET, and TARGET_IPS/GATEWAY_IP
            # if you have a console to capture (leave blank if not)
./install.sh
```

## Desktop build (Windows/Linux, no Docker)

See [`desktop/README.md`](desktop/README.md). Covers the dashboard, media
relay, and playback protocols only - **not** the ARP-spoof intercept or DNS
hijack, which are Linux-only. Prebuilt binaries are produced by the
`build.yml` GitHub Actions workflow on every push to `master`.

## Dashboard

Open `http://PI_IP:8090`. Multi-account: anyone can sign in with their own
Twitch account and manage their own destinations, independently of anyone
else's.

### Twitch app setup (one-time, required for login to work at all)

1. Create an app at https://dev.twitch.tv/console/apps
2. Set its **OAuth Redirect URL** to exactly `TWITCH_REDIRECT_URI` from
   your `.env` (e.g. `http://<PI_IP>:8090/auth/twitch/callback`)
3. Put the generated Client ID/Secret into `.env` as `TWITCH_CLIENT_ID` /
   `TWITCH_CLIENT_SECRET`

### How accounts and matching work

- Sign in with Twitch. On first login you're asked to paste your Twitch
  stream key (Twitch's API never exposes this - `dashboard.twitch.tv/settings/stream`
  is the only place to get it) and pick how you'll stream - **console**,
  **PC streaming software**, or **both**. This is how the dashboard
  recognizes which registered account an incoming broadcast belongs to: the
  RTMP path a source publishes under is literally the real stream key, so
  it's matched directly against each account's registered key. Change your
  choice anytime from the "Connect a source" panel.
- **Console and PC are detected independently** by which RTMP app name the
  path was published under (`app/<key>` for console, mirroring Twitch's own
  ingest scheme; `live/<key>` for PC software, this project's own
  convention) - so with "both" selected, the dashboard can show each one's
  live status separately instead of one hiding the other. Only one drives
  the actual destination pushes at a time (most RTMP destinations only
  accept one publisher per stream key anyway): whichever goes live first,
  with automatic failover to the other if it's still live when the first
  one stops.
- **Reconnect grace window:** if a stream drops and there's no other source
  to fail over to, outputs aren't torn down immediately - the dashboard
  waits up to an hour (`RECONNECT_GRACE_MS` in `.env`, default `3600000`)
  for the same source to reconnect (flaky wifi, a console reboot, OBS
  crashing and relaunching, etc.) before actually ending the stream and
  stopping every destination. The dashboard shows "Reconnecting… Xm left"
  during this window; reconnecting at any point resumes automatically with
  no action needed.
- Destinations are managed entirely per-account - add, rename, edit the
  URL, enable/disable, or delete, all in real time, no `.env` editing or
  restart required. Both `rtmp://`/`rtmps://` and `srt://` URLs are
  supported.
- Toggling a destination on/off takes effect immediately if that account's
  stream is currently live - it starts or stops just that one output, the
  others keep running.
- When an account's only live source stops, its outputs keep running
  through the reconnect grace window above and only actually stop if
  nothing reconnects before it expires (if another source is still live,
  outputs fail over to it immediately instead - no grace window needed).
  Re-enabling a destination just marks it for next time; it resumes
  automatically the next time that account goes live.
- While live, the dashboard also shows direct playback URLs (HLS, RTSP,
  SRT, WHEP) for pulling the raw feed into VRChat, VLC, OBS, etc. without
  going through any platform at all. These are always served from a
  per-account path (`public/<twitch-username>`) - **never** the raw
  MediaMTX path, which is literally the real Twitch stream key. The
  dashboard internally republishes each live account's feed under that
  fixed path specifically so these URLs can be shared/pasted without
  exposing anything that could be used to hijack the real Twitch stream.
  - **HLS and WHEP are reverse-proxied through the dashboard's own
    port** (`/hls/...`, `/webrtc/...`), since both are plain HTTP - so
    they automatically pick up whatever domain/scheme you're actually
    viewing the dashboard through (works with just NPM forwarding the
    dashboard's port, nothing extra to expose).
  - **RTSP and SRT are raw TCP/UDP, not HTTP** - there's no such thing as
    reverse-proxying them through a web proxy. Their URLs use the same
    hostname you're viewing the dashboard from, but ports `8554`/`8890`
    still need to be reachable directly at that host (forwarded/exposed
    as their own ports, not through NPM).

## Console DNS

Set the console's Primary DNS to the Raspberry Pi LAN IP:

```text
Primary DNS: PI_IP
Secondary DNS: 0.0.0.0
```

## Logs

```bash
docker compose logs -f mediamtx
docker compose logs -f dashboard
# only running if TARGET_IPS is set (console capture):
docker compose logs -f dns
docker compose logs -f intercept
```

## Important

This is a LAN-only prototype. Do not expose DNS port 53, RTMP port 1935,
MediaMTX's other ports, or the dashboard port to the public internet.
Console capture's ARP-spoof intercept (only running if `TARGET_IPS` is set)
actively manipulates ARP tables for the console and your LAN gateway -
scoped only to that one device pair, but still something to be aware of on
a shared home network. PC streaming software doesn't touch DNS or ARP at
all - it just pushes to the dashboard's RTMP port like any other RTMP
target.
