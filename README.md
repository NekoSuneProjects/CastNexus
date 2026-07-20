# NekoSune Restream Node

Take a broadcast and fan it out to your own RTMP/SRT destinations, managed
live from a web dashboard - instead of (or as well as) the real platform.
There are **two independent ways to get a stream in**, and each dashboard
account picks which one(s) it uses right after signing in - **console**, **PC
streaming software**, or **both**:

- **PC streaming software** - point OBS (or any RTMP-capable software) at
  this box like any normal RTMP target: a server URL + a stream key
  **the dashboard generates for you** - never your real Twitch stream key,
  so there's nothing Twitch-related to expose to third-party software, and
  it can be rotated anytime without touching your Twitch account at all.
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
   Twitch. On first login, pick **PC streaming software** (or **Both**) as
   how you'll stream - no Twitch stream key needed for this.
3. **Add at least one destination** (the "+ Add destination" button) - a
   full `rtmp://` or `srt://` URL including that destination's own stream
   key, and turn it on. (Want to restream to your own Twitch channel too?
   Add it here as a normal destination using your real Twitch key - that's
   completely separate from the account-level matching key below.)
4. In the dashboard's **"Connect a source" -> "PC / software"** tab, copy
   the server URL (`rtmp://<Pi LAN IP>:1935/live`) and the **stream key
   shown there** (a key the dashboard generated just for this - never your
   Twitch key). In OBS: Settings -> Stream -> Service: Custom -> Server:
   that URL -> Stream Key: that generated key.
5. **Start streaming in OBS.** Watch the dashboard - the status badge should
   flip to "Live (PC)", the preview player should start playing, and your
   enabled destination(s) should show "Pushing now".
6. Stopping the stream in OBS automatically stops every destination -
   nothing to clean up (unless Console is also live for this account, in
   which case outputs fail over to it).

If that generated key ever leaks, hit **Regenerate key** in the same tab -
it takes effect immediately (just update OBS's Stream Key field afterward).
It's ours to rotate freely since it isn't tied to your Twitch account at
all.

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
   Twitch. On first login, pick **Console** (or **Both**) as how you'll
   stream, then paste your Twitch stream key (from
   `dashboard.twitch.tv/settings/stream`) when asked - this is the only way
   an incoming console broadcast can be matched to your account.
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

- Sign in with Twitch. On first login you pick how you'll stream -
  **console**, **PC streaming software**, or **both** - before anything
  else. Change your choice anytime from the "Connect a source" panel.
- **Two separate matching keys, never mixed up:**
  - **Console** is matched by your real Twitch stream key (Twitch's API
    never exposes this - `dashboard.twitch.tv/settings/stream` is the only
    place to get it), asked for right after picking console/both - it's the
    only way an incoming console broadcast can be matched to your account,
    since the RTMP path a console publishes under is literally that key.
  - **PC streaming software** is matched by a key **the dashboard generates
    for you** instead - shown in full in "Connect a source" -> "PC /
    software" (with a "Regenerate key" button), and never your real Twitch
    key. This means your Twitch stream key is never typed into OBS or any
    third-party software, and the PC key can be rotated anytime with zero
    effect on your Twitch account. Want to restream to your own Twitch
    channel from a PC-mode source? Add it as a normal destination with your
    real Twitch key, same as Kick or any custom RTMP target - that's
    unrelated to this account-level matching key.
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

## Overlays & scenes

The dashboard's **"Overlays & scenes"** panel serves browser-source pages
you add as an OBS Browser Source (or any scene software with the same
concept) - independent of console/PC ingest, so this works no matter which
mode you're using.

### Switch scenes live, without touching OBS

Add the **master scene switcher** URL as a single Browser Source and leave
it there. Buttons in the dashboard ("None" / Starting Soon / BRB / Ending /
any custom Text or HTML overlay) change what it shows **instantly** - no
editing OBS's Browser Source config, no restarting the stream. Under the
hood: the dashboard holds one authoritative "what's showing right now" per
account, and pushes the update to that one already-loaded page over
Server-Sent Events, which swaps its own content in place. (Individual scene
URLs like `/starting-soon`/`/brb`/`/ending` still work too, unchanged, for
anyone who'd rather add each as its own Browser Source and toggle visibility
manually in OBS - the master switcher is an additional, easier option, not a
replacement.)

- **Built-in scenes** - Starting Soon (with an optional countdown), BRB,
  and Ending, each with editable title/subtitle/accent color/background
  image, plus a **Live badge** that shows itself automatically only while
  that account is actually live (polls its own small status endpoint - no
  manual scene switching needed for that one).
- **Custom overlays** - add as many as you want, three types:
  - **Text** - a styled text block (size/color configurable).
  - **HTML** - raw HTML/CSS passthrough for anything the built-ins don't
    cover (same "you're trusted, typos break the overlay" tradeoff as any
    raw-HTML tool).
  - **Music player** - see below.

### Music - one shared, synced playlist

Upload tracks in the **Music library** section; volume/shuffle/loop are set
once for the whole library (not per-overlay). The dashboard runs a small
server-side engine that's the single authority on which track is playing
and how far into it - so every Music-player overlay, and the optional **Now
Playing widget** (layered onto any scene above, master switcher included),
all agree, in sync, no matter which page loaded or reloaded when. Autoplay-
with-sound works in OBS's Browser Source; a regular browser tab may block it
until you click into the page. (The audio itself still plays from whichever
overlay page has it - there's no server-side audio mixing pipeline, since
that would need a compositor this project deliberately doesn't have; see
`docs/design/overlays.md` for the reasoning.)

Every scene/overlay has **Copy URL** / **Open** so you can paste it straight
into OBS's Browser Source URL field. These pages are unauthenticated (OBS
can't log in) but scoped to your account's login, the same trust model
already used for the direct-playback URLs above.

Not yet supported: burning overlays directly into a **console** capture's
video (that pipeline is zero-cost passthrough today, with no compositor at
all) - overlays work great layered in your own OBS scenes regardless of
which source you're using, just not baked into the raw console feed itself.
See [`docs/design/overlays.md`](docs/design/overlays.md) for the full design
and what's left.

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
