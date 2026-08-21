# CastNexus Desktop

CastNexus Desktop is the Windows/Linux launcher build for running the CastNexus dashboard and MediaMTX relay without Docker.

## Platforms

Release builds are produced for:

- **Windows x64** — `CastNexus-Windows-x64.zip`
- **Linux x64** — `CastNexus-Linux-x64.tar.gz`

Each release bundle contains:

- CastNexus launcher
- MediaMTX
- **yt-dlp nightly**
- **Deno**

The launcher starts MediaMTX, starts the bundled CastNexus dashboard, adds the bundled yt-dlp/Deno tools to the app runtime, checks the configured GitHub Release channel for updates, and opens Studio at `http://localhost:8090`.

## Update channels

CastNexus has two channels:

- **Stable** — normal GitHub Releases such as `v1.2.0`. Stable builds only notify you about newer stable releases.
- **Beta** — GitHub prereleases such as `v1.3.0-beta.2`. Beta builds follow the newest beta/stable release so you can test changes before promotion to stable.

The desktop launcher checks for a newer release at startup. On Windows it attempts a native notification balloon; on Linux it uses `notify-send` when available. The CastNexus web UI also displays an update card with a link to the release.

Desktop updating is intentionally user-controlled: download the newer release bundle, close CastNexus, replace the application files, and launch it again. Your saved account/configuration data lives outside the application bundle, so replacing the executable does not wipe it.

## Included

- CastNexus Studio dashboard
- PC/OBS RTMP ingest
- MediaMTX relay
- LL-HLS / RTSP / SRT / WebRTC playback
- multi-destination FFmpeg restreaming
- profiles, scenes and Browser Source overlays
- profile-isolated music libraries
- **Twitch live HLS/m3u8 relay** for broadcasts you are authorized to relay
- **Twitch VOD reruns**
- **YouTube video / past-livestream reruns**
- **uploaded rerun-video library** scoped to each profile
- yt-dlp nightly + Deno URL resolving
- update notification system

## Reruns / VOD

Use the **Reruns / VOD** page in Studio.

Each profile has its own rerun library. Uploaded videos are stored as rerun assets only; CastNexus does not expose those files as Overlay Studio backgrounds or scene media.

Available inputs:

1. Twitch live channel — CastNexus resolves Twitch's HLS/m3u8 feed and republishes it through the normal destination fan-out.
2. Twitch VOD / past broadcast URL.
3. YouTube video or past-livestream URL.
4. Manually uploaded video file.

Remote Twitch/YouTube content should only be used when you own the content or have permission to relay/rerun it.

### YouTube and server IPs

Current YouTube extraction can be sensitive to hosting/datacenter/VPS IP addresses. A normal home/residential connection is generally more reliable for URL resolving, although no connection type is guaranteed to avoid every YouTube challenge.

CastNexus intentionally does **not** request or import browser cookies. If YouTube responds with a sign-in, cookie, anti-bot or similar challenge, CastNexus reports the URL as unavailable and asks you to upload the video manually to the profile VOD library instead.

The release bundle includes current yt-dlp nightly and Deno, so a normal desktop release does not require you to install those two tools separately.

## Desktop limitations

The desktop bundle does **not** bundle the console ARP-spoof/DNAT + DNS capture containers. Those are part of the Linux/Docker deployment because they require privileged networking tools.

The full Docker Music 24/7 sidecar is also designed for the Docker stack where Chromium + FFmpeg are bundled in the dashboard image. The desktop launcher can use the normal music/overlay UI, but the guaranteed always-on headless music worker is a Docker feature.

## Prerequisite

**FFmpeg must be installed and available on `PATH`** for restream destination pushes, VOD playback/reruns and other FFmpeg-backed features.

Windows users can install an FFmpeg build and add its `bin` directory to PATH. Linux users can use their distribution package manager, for example:

```bash
sudo apt install ffmpeg
```

## Running

### Windows

Extract the ZIP and run:

```text
CastNexus.exe
```

Keep these files beside it:

```text
CastNexus.exe
mediamtx.exe
yt-dlp.exe
deno.exe
```

### Linux

Extract the archive and run:

```bash
chmod +x CastNexus mediamtx yt-dlp deno
./CastNexus
```

## Data directory

New installs store data in:

- Windows/Linux: `~/.castnexus`

Profile VOD files live below the configured data directory in:

```text
vod/<account-id>/<profile-id>/
```

Profile music remains separate in:

```text
music/<account-id>/<profile-id>/
```

For compatibility, if the previous `.nekosune-ps5-streamer` directory exists and `.castnexus` does not, CastNexus continues using the legacy directory automatically so an upgrade does not appear to lose saved state.

Environment overrides:

- `CASTNEXUS_DATA_DIR` — custom CastNexus data directory
- `NEKOSUNE_DATA_DIR` — legacy alias, still accepted
- `PI_IP` — override detected LAN IP
- `DASHBOARD_PORT` — default `8090`
- `MEDIAMTX_BIN` — override MediaMTX binary path
- `YTDLP_BIN` — override bundled/system yt-dlp executable
- `NO_OPEN_BROWSER=true` — do not automatically open the Studio UI

## Build locally

```bash
cd dashboard
npm ci --omit=dev

cd ../desktop
npm install
npx pkg . --targets node18-linux-x64 --output dist/CastNexus
npx pkg . --targets node18-win-x64 --output dist/CastNexus.exe
```

Local source builds do not automatically download MediaMTX/yt-dlp/Deno. GitHub Release builds are handled by `.github/workflows/release.yml`, which stamps the selected version/channel and assembles the complete runtime bundle.
