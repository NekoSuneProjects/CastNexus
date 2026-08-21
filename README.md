# CastNexus

**CastNexus** is a self-hosted broadcast control studio for restreaming sources to multiple destinations, adding browser/HTML overlays, switching broadcast profiles, running an always-on music station, and rerunning authorized Twitch/YouTube/video content.

It is designed around three main profile workflows:

1. **PC Streaming** — OBS, Streamlabs or another RTMP encoder publishes to CastNexus, or the profile can use CastNexus's Twitch HLS / VOD rerun engine as its program source.
2. **Console Streaming** — a supported console Twitch broadcast is intercepted on the network and routed through CastNexus.
3. **Music 24/7** — Docker renders a full music scene with a live spectrum and continuously publishes the active profile's uploaded music without needing OBS open.

CastNexus uses **MediaMTX** for ingest/playback, **FFmpeg** for destination fan-out and audio/video processing, **yt-dlp nightly + Deno** for supported Twitch/YouTube URL resolving, and an optional **headless Chromium compositor** for server-side overlays.

---

## Features

### Broadcast sources

- PC / OBS RTMP ingest using a CastNexus-generated key
- Console Twitch capture using the DNS + ARP/DNAT interception system
- **Twitch live HLS/m3u8 relay** for broadcasts you own/are authorized to relay
- **Twitch VOD / past-broadcast reruns**
- **YouTube video / past-livestream reruns**
- **profile-scoped uploaded video reruns**
- independent PC, console and internal rerun source detection
- automatic source failover
- configurable reconnect grace period
- Docker Music 24/7 source

The internal rerun engine publishes to `relay/<pc-key>`, while OBS remains on `live/<pc-key>`. They never publish to the same MediaMTX path.

### Restream destinations

Add as many per-account outputs as needed:

- RTMP
- RTMPS
- SRT
- Twitch
- YouTube
- Kick
- custom streaming servers

Destinations can be enabled/disabled live from the Studio UI and can independently use Source/passthrough, 16:9 Landscape, or 9:16 Vertical output.

### Reruns / VOD

Each profile gets a separate VOD/rerun library.

Supported inputs:

- Twitch live channel name or URL → resolved HLS/m3u8 relay
- Twitch VOD URL
- YouTube video / past livestream URL
- uploaded video file

Uploaded rerun videos live under:

```text
data/vod/<account-id>/<profile-id>/
```

They are **rerun assets only**. They are not exposed as Overlay Studio backgrounds or scene-media choices.

Remote Twitch/YouTube features require confirmation that you own the content or have permission to relay/rerun it.

#### YouTube URL resolving

CastNexus uses current **yt-dlp nightly** with **Deno**. The Docker dashboard image includes both, and Windows/Linux GitHub Release bundles include both beside the CastNexus executable.

YouTube can apply additional challenges to VPS/datacenter/hosting-provider IP ranges. A normal home/residential connection is generally more reliable for URL resolving, although it cannot guarantee every URL will work.

CastNexus intentionally does **not** request/import browser cookies. If YouTube returns a sign-in, cookie, anti-bot or related 403 challenge, CastNexus reports that condition and asks you to upload the video manually to the VOD library.

See [`docs/VOD-RERUNS.md`](docs/VOD-RERUNS.md).

### Overlay Studio

CastNexus provides one master Browser Source plus individual scene URLs.

Built-in scenes:

- Starting Soon
- BRB / Intermission
- Ending
- Offline
- Music / Radio
- Live badge
- Now Playing widget

Starting Soon supports both:

- a fixed date/time target
- **relative countdown from activation**, e.g. `10` minutes

With a 10-minute relative timer, every time Starting Soon is activated CastNexus creates a fresh target ten minutes from that moment.

Custom overlays:

- **Browser / iframe** — ideal for StreamElements, Streamlabs alerts, chat boxes and trusted browser widgets
- **HTML / CSS** — raw trusted custom overlay code
- **Text** — configurable text overlays
- **Music** — full spectrum/music visual scene

Browser overlays use a sandbox that allows the JavaScript commonly required by alert widgets without granting popup/forms/top-navigation permissions.

### Music / Radio

Music is isolated by profile. A PC Gaming profile can keep a creator-safe/NCS-style BRB library while a separate Radio profile contains an entirely different library.

Each profile has its own:

- track list and files
- shuffle / loop / volume settings
- playback timeline
- visual settings

PC/Console profiles can optionally play their own profile music only on Starting Soon / BRB / Ending scenes.

The music scene includes:

- 48 spectrum bars
- Web Audio `AnalyserNode`
- FFT size 256
- smooth 30 FPS visualizer
- procedural fallback spectrum
- animated vinyl
- title / artist metadata
- progress bar
- elapsed + total time
- clock
- station name
- custom accent/background/cover
- dedicated 16:9 and 9:16 compositions

### Profiles

Profiles work like separate broadcast workspaces. Examples:

- `PC Gaming`
- `Console Gaming`
- `CastNexus Radio`
- `Nekoryza 24/7`

A profile remembers its:

- mode: PC / Console / Music
- default canvas: 16:9 / 9:16
- enabled destination IDs
- current scene
- compositor preference
- isolated music library/settings
- isolated VOD/rerun library
- music visual settings

Switch profiles from the top bar in CastNexus Studio.

---

# CastNexus Studio UI

The web dashboard is a responsive dark/glass broadcast control interface with:

- Overview
- Sources
- Destinations
- Overlay Studio
- Music / 24/7
- **Reruns / VOD**
- Profiles
- Settings
- live/reconnecting status
- program preview
- Twitch account avatar
- profile switcher
- update notifications

Open it at:

```text
http://<CASTNEXUS_HOST>:8090
```

---

# Docker install

Copy the environment template:

```bash
cp .env.example .env
nano .env
```

Configure at minimum:

```dotenv
PI_IP=192.168.1.50
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_REDIRECT_URI=http://192.168.1.50:8090/auth/twitch/callback
```

For console capture also configure:

```dotenv
TARGET_IPS=192.168.1.100
GATEWAY_IP=192.168.1.1
```

Then start CastNexus.

For PC/Music only:

```bash
docker compose up -d
```

For console capture helpers as well:

```bash
docker compose --profile console up -d
```

The dashboard Docker image contains FFmpeg, Chromium, yt-dlp nightly and Deno, so Twitch/YouTube VOD resolving does not need separate helper containers.

---

# Stable and Beta channels

CastNexus deliberately separates test builds from production releases.

## Stable

```dotenv
CASTNEXUS_IMAGE_TAG=latest
CASTNEXUS_CHANNEL=stable
```

Images:

```text
ghcr.io/nekosuneprojects/castnexus-dashboard:latest
ghcr.io/nekosuneprojects/castnexus-dns:latest
ghcr.io/nekosuneprojects/castnexus-intercept:latest
```

Stable releases use normal semantic-version tags such as `v1.2.0` and are marked as the latest GitHub Release.

## Beta

```dotenv
CASTNEXUS_IMAGE_TAG=beta
CASTNEXUS_CHANNEL=beta
```

Images:

```text
ghcr.io/nekosuneprojects/castnexus-dashboard:beta
ghcr.io/nekosuneprojects/castnexus-dns:beta
ghcr.io/nekosuneprojects/castnexus-intercept:beta
```

Beta versions use prerelease tags such as `v1.3.0-beta.1`. GitHub marks them as **Pre-release**, so they can be tested without replacing stable/latest.

---

# Creating a release

Release builder:

```text
.github/workflows/release.yml
```

Open **GitHub → Actions → CastNexus Release → Run workflow**.

## Make a beta

Choose:

```text
Channel: beta
Version: 1.3.0
```

If there is no prerelease suffix the workflow creates one similar to:

```text
1.3.0-beta.<workflow run number>
```

The workflow then:

1. builds `linux/amd64` + `linux/arm64` Docker images
2. publishes exact-version Docker tags
3. updates the `:beta` Docker tags
4. builds CastNexus Desktop for Windows x64
5. builds CastNexus Desktop for Linux x64
6. bundles MediaMTX + yt-dlp nightly + Deno into desktop packages
7. creates a GitHub **Pre-release**
8. attaches the Windows/Linux downloads
9. generates release notes

## Promote a stable release

Run the same workflow **from `main`** with:

```text
Channel: stable
Version: 1.3.0
```

Stable release dispatches are intentionally blocked from non-`main` branches. Stable builds update Docker `:latest`, create a normal GitHub Release and mark it as latest.

---

# Updating Docker

## Stable

```bash
CASTNEXUS_IMAGE_TAG=latest CASTNEXUS_CHANNEL=stable docker compose pull
docker compose up -d
```

## Beta

```bash
CASTNEXUS_IMAGE_TAG=beta CASTNEXUS_CHANNEL=beta docker compose pull
docker compose up -d
```

CastNexus embeds its version/channel into each release build. Studio checks GitHub Releases and displays an update notification when a newer release exists for the installed channel. Stable installations ignore beta/prerelease versions.

---

# Desktop — Windows and Linux

Release assets:

```text
CastNexus-Windows-x64.zip
CastNexus-Linux-x64.tar.gz
```

Each release bundle includes the CastNexus launcher, MediaMTX, yt-dlp nightly and Deno. **FFmpeg is still a desktop host prerequisite** for restream/VOD processing.

See [`desktop/README.md`](desktop/README.md) for full desktop information.

Desktop application data is stored in:

```text
~/.castnexus
```

For upgrade compatibility, CastNexus continues using the older `.nekosune-ps5-streamer` directory when it already exists and the new directory has not yet been created.

> Desktop does not bundle the privileged console DNS/ARP interception containers. Use Docker/Linux for full console interception and the guaranteed Docker Music 24/7 worker.

---

# PC / OBS setup

1. Sign in to CastNexus with Twitch.
2. Create or choose a **PC Streaming** profile.
3. Open **Sources**.
4. Copy the CastNexus RTMP server and generated PC key.
5. In OBS choose a Custom streaming service.
6. Paste the server + CastNexus key.
7. Configure Destinations.
8. Start OBS.

The generated PC ingest key is separate from the real Twitch stream key and can be rotated from CastNexus.

## PC Twitch relay / VOD rerun

Instead of OBS, a PC profile can open **Reruns / VOD** and start:

- an authorized Twitch live HLS relay
- a Twitch VOD
- a YouTube VOD/past livestream
- an uploaded video

The internal source appears as **Rerun** and uses the same destination fan-out as a normal PC source.

If OBS is already active, the rerun/relay remains standby rather than stealing the currently active program source.

---

# Console setup

Console Twitch capture requires the Docker/Linux network helpers.

1. Configure `TARGET_IPS` and `GATEWAY_IP`.
2. Start Compose using the `console` profile.
3. Point the console DNS at the CastNexus host.
4. Sign in to CastNexus.
5. Create or choose a **Console Streaming** profile.
6. Paste the Twitch stream key when requested.
7. Start the console Twitch broadcast.
8. CastNexus captures the stream and fans it out to enabled destinations.

The Twitch stream key is masked after it is saved.

---

# Music 24/7 setup

1. Start the normal Docker stack.
2. Sign in to CastNexus.
3. Create a **24/7 Music** profile.
4. Open **Music / 24/7**.
5. Upload tracks.
6. Configure shuffle / loop / volume.
7. Configure music scene appearance.
8. Enable the destinations you want.

The `music24` service watches the active profile. When a Music profile is active and has tracks it renders and publishes that profile's isolated station.

---

# Browser overlay examples

## StreamElements / Streamlabs

Open **Overlay Studio → New overlay → Browser / iframe** and paste the widget/browser-source URL.

Choose full-screen or fixed width/height/X/Y positioning, then either activate it through the master scene switcher or copy its individual Browser Source URL into OBS.

## Custom HTML

Use **HTML / CSS** for trusted code you own. For unknown third-party scripts use the sandboxed Browser / iframe option instead.

---

# Playback

While an account is live CastNexus provides:

- WebRTC / WHEP
- HLS
- RTSP
- SRT

The public playback path uses the Twitch login instead of exposing the raw stream-key path.

---

# CI vs Release builds

`.github/workflows/build.yml` is **CI only**. It validates JavaScript, profile isolation/VOD resolver logic, performs non-publishing Docker builds and smoke-packages the Linux desktop app.

It does **not** publish `latest`.

Only `.github/workflows/release.yml` promotes Docker images or creates GitHub Releases.

---

## Project layout

```text
CastNexus/
├── dashboard/
│   ├── public/               # CastNexus Studio frontend
│   ├── profile-music.js      # profile-isolated music service
│   ├── profile-vod.js        # Twitch HLS + VOD/upload rerun service
│   ├── destination-output.js # source / 16:9 / 9:16 destination encoder
│   ├── music24.js            # always-on Docker music worker
│   ├── music-scene.js        # landscape/vertical spectrum scene
│   ├── scenes.js             # Starting Soon / BRB / Ending / Offline
│   └── overlays.js           # browser, HTML, text and master overlays
├── desktop/                  # Windows/Linux launcher build
├── dns/                      # console DNS capture helper
├── intercept/                # console ARP/DNAT capture helper
├── config/                   # MediaMTX configuration
├── docs/
│   ├── PROFILE-MUSIC-DUAL-FORMAT.md
│   └── VOD-RERUNS.md
├── docker-compose.yml
└── .github/workflows/
    ├── build.yml             # validation / CI
    └── release.yml           # beta + stable releases
```

---

## Credits

CastNexus includes scene/compositor ideas adapted from the `docker` branch of the NekoStreamAPP/CacheStream work while keeping CastNexus on its own lightweight Express + MediaMTX architecture.
