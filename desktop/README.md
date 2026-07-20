# NekoSune PS5 Streamer - Desktop build

A native Windows/Linux build of the dashboard + media relay, for running on
a regular PC instead of a Raspberry Pi + Docker.

## What's included vs. the Pi/Docker setup

Included:

- The web dashboard (login, destinations CRUD, live preview, playback URLs)
- MediaMTX (RTMP ingest, LL-HLS/RTSP/SRT/WHIP playback)
- The per-destination ffmpeg push/multistream relay

**Not included: the ARP-spoof + DNAT intercept and the DNS hijack.** Those
rely on Linux-only tools (`arpspoof`, `iptables`) with no safe Windows
equivalent, so on desktop you're relying on the PS5 doing a fresh DNS lookup
for the Twitch/YouTube ingest host pointed at this machine - which, per our
own testing, doesn't reliably happen. If you need guaranteed interception,
run the Pi/Docker setup instead; this desktop build is best suited to
capturing/relaying a stream you're already pushing here directly (e.g. via
OBS, or a console/capture device that lets you set a custom RTMP target).

## Prerequisites

- **ffmpeg** must be installed and on your `PATH`. It is not bundled.
  - Windows: https://www.gyan.dev/ffmpeg/builds/ (add the `bin` folder to PATH)
  - Linux: `apt install ffmpeg` / your distro's package manager

## Running it

1. Download the release for your platform - it contains the launcher
   executable and a `mediamtx` binary that must sit next to it.
2. Run the launcher (double-click on Windows, `./launcher-linux-x64` on
   Linux). It starts MediaMTX, starts the dashboard, and opens your browser
   to `http://localhost:8090`.
3. Log in with `admin` / `changeme` and set a new password.
4. Add destinations and point whatever is sending you RTMP/SRT at
   `rtmp://<this-pc-ip>:1935/<anything>` or `srt://<this-pc-ip>:8890`.

## Configuration (environment variables)

- `PI_IP` - override the LAN IP used to build playback URLs (auto-detected otherwise)
- `DASHBOARD_PORT` - default `8090`
- `MEDIAMTX_BIN` - override the path to the mediamtx binary
- `NEKOSUNE_DATA_DIR` - where state/config is stored (default `~/.nekosune-ps5-streamer`)
- `NO_OPEN_BROWSER=true` - don't auto-open a browser tab

## Building from source

```bash
cd dashboard && npm install --omit=dev
cd ../desktop && npm install
npx pkg . --targets node18-linux-x64 --output dist/launcher-linux-x64
npx pkg . --targets node18-win-x64 --output dist/launcher-win-x64.exe
```

Then place a matching `mediamtx`/`mediamtx.exe` binary (from
https://github.com/bluenviron/mediamtx/releases) next to the built
executable.
