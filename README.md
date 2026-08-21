# CastNexus

**CastNexus** is a self-hosted broadcast control studio for restreaming one source to multiple destinations, adding browser/HTML overlays, switching broadcast profiles, and running an always-on music station.

It is designed around three workflows:

1. **PC Streaming** — OBS, Streamlabs or another RTMP encoder publishes to CastNexus.
2. **Console Streaming** — a supported console Twitch broadcast is intercepted on the network and routed through CastNexus.
3. **Music 24/7** — Docker renders a full music scene with a live spectrum and continuously publishes uploaded music without needing OBS open.

CastNexus uses **MediaMTX** for ingest/playback, **FFmpeg** for destination fan-out and audio/video processing, and an optional **headless Chromium compositor** for server-side overlays.

---

## Features

### Broadcast sources

- PC / OBS RTMP ingest using a CastNexus-generated key
- Console Twitch capture using the existing DNS + ARP/DNAT interception system
- independent PC and console source detection
- automatic source failover
- configurable reconnect grace period
- Docker Music 24/7 source

### Restream destinations

Add as many per-account outputs as needed:

- RTMP
- RTMPS
- SRT
- Twitch
- YouTube
- Kick
- custom streaming servers

Destinations can be enabled/disabled live from the Studio UI.

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

Custom overlays:

- **Browser / iframe** — ideal for StreamElements, Streamlabs alerts, chat boxes and trusted browser widgets
- **HTML / CSS** — raw trusted custom overlay code
- **Text** — configurable text overlays
- **Music** — full spectrum/music visual scene

Browser overlays use a sandbox that allows the JavaScript commonly required by alert widgets without granting popup/forms/top-navigation permissions.

### Music / Radio

The music scene includes:

- 48 spectrum bars
- Web Audio `AnalyserNode`
- FFT size 256
- smoothing 0.78
- 30 FPS visualizer
- procedural fallback spectrum
- animated vinyl
- title / artist metadata
- progress bar
- elapsed + total time
- clock
- station name
- custom accent
- background image
- cover/logo image

The shared music engine keeps the Music scene and Now Playing widgets on the same authoritative track timeline.

### Profiles

Profiles work like separate broadcast workspaces. Examples:

- `PC Gaming`
- `Console Gaming`
- `CastNexus Radio`
- `Nekoryza 24/7`

A profile remembers its:

- mode: PC / Console / Music
- enabled destination IDs
- current scene
- compositor preference
- music shuffle / loop / volume
- music visual settings

Switch profiles from the top bar in CastNexus Studio.

---

# CastNexus Studio UI

The web dashboard is a responsive dark/glass broadcast control interface with:

- Overview
- Sources
- Destinations
- Overlay Studio
- Music 24/7
- Profiles
- Settings
- live/reconnecting status
- program preview
- Twitch account avatar
- profile switcher
- modals and confirmations
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

The existing `install.sh` can also be used for the Raspberry Pi deployment.

---

# Stable and Beta channels

CastNexus deliberately separates test builds from production releases.

## Stable

Stable Docker installs use:

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

A stable GitHub release uses a normal semantic-version tag such as:

```text
v1.2.0
```

Stable GitHub releases are normal releases and are marked as the latest release.

## Beta

Beta Docker installs use:

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

Beta versions use prerelease tags such as:

```text
v1.3.0-beta.1
```

GitHub marks them as **Pre-release**, so they can be tested without replacing the stable/latest release.

---

# Creating a release

The release builder is:

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

If the version does not already contain a prerelease suffix, the workflow automatically creates a version similar to:

```text
1.3.0-beta.<workflow run number>
```

The workflow then:

1. builds `linux/amd64` + `linux/arm64` Docker images
2. publishes exact-version Docker tags
3. updates the `:beta` Docker tags
4. builds CastNexus Desktop for Windows x64
5. builds CastNexus Desktop for Linux x64
6. creates a GitHub **Pre-release**
7. attaches the Windows/Linux downloads
8. asks GitHub to generate release notes from the changes since the previous release

## Promote a stable release

Run the same workflow **from `main`** with:

```text
Channel: stable
Version: 1.3.0
```

Stable release dispatches are intentionally blocked from non-`main` branches.

The stable build:

- publishes exact Docker version tags
- updates Docker `:latest`
- creates a normal GitHub Release
- marks it as the latest release
- attaches Windows/Linux desktop bundles
- generates release notes

You can also push normal `v*` tags. A tag containing a prerelease suffix is treated as beta; a normal `v1.2.3` tag is stable.

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

CastNexus embeds its version/channel into each release build. The Studio UI checks GitHub Releases periodically and displays an update notification when a newer release exists for the installed channel.

Stable installations ignore beta/prerelease versions.

---

# Desktop — Windows and Linux

Release assets are built for:

```text
CastNexus-Windows-x64.zip
CastNexus-Linux-x64.tar.gz
```

See [`desktop/README.md`](desktop/README.md) for full desktop information.

The desktop launcher:

- starts MediaMTX
- starts the bundled CastNexus dashboard
- opens the Studio UI
- checks for updates at startup
- attempts a native Windows notification or Linux `notify-send` notification when a newer version exists
- also gets the normal in-dashboard update notification

Desktop application data is stored in:

```text
~/.castnexus
```

For upgrade compatibility, CastNexus automatically continues using the older `.nekosune-ps5-streamer` directory when that directory already exists and the new directory has not yet been created.

> Desktop does not bundle the privileged console DNS/ARP interception containers. Use the Docker/Linux deployment for full console interception and the guaranteed Docker Music 24/7 worker.

---

# PC / OBS setup

1. Sign in to CastNexus with Twitch.
2. Create or choose a **PC Streaming** profile.
3. Open **Sources**.
4. Copy the CastNexus RTMP server and generated PC key.
5. In OBS choose a Custom streaming service.
6. Paste the server + CastNexus key.
7. Configure your Destinations.
8. Start OBS.

The generated PC ingest key is separate from the real Twitch stream key and can be rotated from CastNexus.

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
4. Open **Music 24/7**.
5. Upload tracks.
6. Configure shuffle / loop / volume.
7. Configure the music scene accent, background, station name and cover.
8. Enable the destinations you want.

The `music24` service watches the active profile. When a Music profile is active and at least one track exists it automatically renders and publishes the station.

Switching away from the Music profile stops its generated broadcast.

### Important

A Music profile publishes through the account's CastNexus PC ingest path. Do not leave OBS publishing with the same CastNexus PC key while activating Music 24/7, because two publishers cannot safely own the same MediaMTX path.

---

# Browser overlay examples

## StreamElements / Streamlabs

Open **Overlay Studio → New overlay → Browser / iframe** and paste the widget/browser-source URL.

Choose either:

- full-screen
- fixed width + height
- X/Y position
- transparent background

Then either:

- activate it through the CastNexus master scene switcher, or
- copy its individual Browser Source URL into OBS.

## Custom HTML

Use **HTML / CSS** for trusted code you own.

Do not use the raw HTML mode simply to embed an unknown third-party script; use the sandboxed Browser / iframe option instead.

---

# Playback

While an account is live CastNexus provides playback endpoints for:

- WebRTC / WHEP
- HLS
- RTSP
- SRT

The public playback path uses the Twitch login instead of exposing the raw stream-key path.

---

# CI vs Release builds

`.github/workflows/build.yml` is now **CI only**. It validates JavaScript, performs non-publishing Docker builds and smoke-packages the Linux desktop app.

It does **not** publish `latest`.

Only `.github/workflows/release.yml` promotes Docker images or creates GitHub Releases. This prevents an ordinary development push from accidentally replacing the production image.

---

## Project layout

```text
CastNexus/
├── dashboard/                # Studio API/UI, overlays, compositor, music
│   ├── public/               # modern CastNexus Studio frontend
│   ├── music24.js            # always-on Docker music worker
│   ├── music-scene.js        # spectrum/radio scene
│   ├── scenes.js             # Starting Soon / BRB / Ending / Offline
│   └── overlays.js           # browser, HTML, text and master overlays
├── desktop/                  # Windows/Linux launcher build
├── dns/                      # console DNS capture helper
├── intercept/                # console ARP/DNAT capture helper
├── config/                   # MediaMTX configuration
├── docs/
├── docker-compose.yml
└── .github/workflows/
    ├── build.yml             # validation / CI
    └── release.yml           # beta + stable releases
```

---

## Credits

CastNexus includes scene/compositor ideas adapted from the `docker` branch of the NekoStreamAPP/CacheStream work while keeping CastNexus on its own lightweight Express + MediaMTX architecture.
