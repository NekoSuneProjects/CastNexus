# CastNexus Desktop

CastNexus Desktop is the Windows/Linux launcher build for running the CastNexus dashboard and MediaMTX relay without Docker.

## Platforms

Release builds are produced for:

- **Windows x64** — `CastNexus-Windows-x64.zip`
- **Linux x64** — `CastNexus-Linux-x64.tar.gz`

Each release bundle contains the CastNexus launcher plus a matching MediaMTX binary. The launcher starts MediaMTX, starts the bundled CastNexus dashboard, checks the configured GitHub Release channel for updates, and opens the Studio UI at `http://localhost:8090`.

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
- update notification system

## Desktop limitations

The desktop bundle does **not** bundle the console ARP-spoof/DNAT + DNS capture containers. Those are part of the Linux/Docker deployment because they require privileged networking tools.

The full Docker Music 24/7 sidecar is also designed for the Docker stack where Chromium + FFmpeg are bundled in the dashboard image. The desktop launcher can use the normal music/overlay UI, but the guaranteed always-on headless music worker is a Docker feature.

## Prerequisite

**FFmpeg must be installed and available on `PATH`** for restream destination pushes and other FFmpeg-backed features.

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

Keep `mediamtx.exe` beside it.

### Linux

Extract the archive and run:

```bash
chmod +x CastNexus mediamtx
./CastNexus
```

## Data directory

New installs store data in:

- Windows/Linux: `~/.castnexus`

For compatibility, if the previous `.nekosune-ps5-streamer` directory exists and `.castnexus` does not, CastNexus continues using the legacy directory automatically so an upgrade does not appear to lose saved state.

Environment overrides:

- `CASTNEXUS_DATA_DIR` — custom CastNexus data directory
- `NEKOSUNE_DATA_DIR` — legacy alias, still accepted
- `PI_IP` — override detected LAN IP
- `DASHBOARD_PORT` — default `8090`
- `MEDIAMTX_BIN` — override MediaMTX binary path
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

GitHub Release builds are handled by `.github/workflows/release.yml`, which stamps the selected version/channel into both the desktop launcher and the web UI before packaging.
