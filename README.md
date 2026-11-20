# CastNexus: Docker

This branch holds **only the Docker install**: compose files, `.env.example`,
`install.sh`, the MediaMTX config and the dashboard `Dockerfile`. The CastNexus
web app itself lives in the
[`dashboard` branch](https://github.com/NekoSuneProjects/CastNexus/tree/dashboard).
That works the same way as the `desktopapp` and `cli` branches, which pull the
dashboard when they need it.

Normal installs don't need the dashboard source at all. `docker-compose.yml`
pulls the published images from `ghcr.io`.

## Install

```bash
git clone --branch docker https://github.com/NekoSuneProjects/CastNexus.git castnexus
cd castnexus
./install.sh      # first run creates .env - edit it (PI_IP etc.), then run again
```

- New to Docker? Start with [docs/BEGINNER-SETUP.md](docs/BEGINNER-SETUP.md).
- The full guide is [INSTALL.md](INSTALL.md).
- Every `.env` option is in [docs/ADVANCED-CONFIGURATION.md](docs/ADVANCED-CONFIGURATION.md).
- Hardware sizing and GPU help is in [docs/HARDWARE-ENCODING.md](docs/HARDWARE-ENCODING.md).

## Update

```bash
git pull               # newest compose files / config
docker compose pull    # newest images
docker compose up -d
```

## Files

| File | What it is |
| --- | --- |
| `docker-compose.yml` | The stack: dashboard, MediaMTX, VRChat relay, optional console DNS/intercept (`--profile console`) |
| `docker-compose.vps.yml` | VPS / public console gateway override ([docs/VPS-CONSOLE-GATEWAY.md](docs/VPS-CONSOLE-GATEWAY.md)) |
| `docker-compose.gpu-nvidia.yml` / `docker-compose.gpu-vaapi.yml` | GPU encoding overrides |
| `docker-compose.build.yml` | Build the dashboard image locally from source (see below) |
| `.env.example` | Settings template, copied to `.env` by `install.sh` |
| `config/` | MediaMTX configs mounted into the MediaMTX containers |
| `Dockerfile` | The `castnexus-dashboard` image. CI builds it from the dashboard branch |
| `fetch-dashboard.sh` | Pulls the dashboard app into `./build/dashboard` for a local build |
| `tools/docker-parity-check.sh` | Live-stream A/V checks against a running stack |
| `docs/` | Docker setup guides, including [Discord Activity](docs/DISCORD-ACTIVITY.md) and [console stream key](docs/CONSOLE-STREAM-KEY.md) |

## Feature switches

Turn parts of CastNexus on or off in `.env`, then run `docker compose up -d`:

```dotenv
CASTNEXUS_MUSIC24=true            # Music 24/7 radio
CASTNEXUS_PC_STREAMING=true       # PC / OBS ingest
CASTNEXUS_CONSOLE_STREAMING=true  # PS5 / Xbox / Switch capture
CASTNEXUS_VOD=true                # VOD Reruns profiles (uploads, Twitch/YouTube VODs, HLS relay)
CASTNEXUS_DISCORD_ACTIVITY=false  # watch your stream inside Discord voice channels
```

Console only (PS5 / Xbox / Switch, with console scenes and scene music):
`CASTNEXUS_MUSIC24=false` and `CASTNEXUS_PC_STREAMING=false`.

## Build the image yourself

```bash
./fetch-dashboard.sh                                   # dashboard branch -> ./build/dashboard
docker compose -f docker-compose.yml -f docker-compose.build.yml build dashboard
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
```

Use `CASTNEXUS_BRANCH=<branch> ./fetch-dashboard.sh` to build another branch
of the app. `./build` is separate from `./dashboard/data`, where your live data
is kept.

## How images are published

The **Publish Docker Image** workflow in the `dashboard` branch builds
`ghcr.io/nekosuneprojects/castnexus-dashboard`. It uses the `dashboard/` app as
the build context and checks out this branch for the `Dockerfile`.

When the `Dockerfile` changes here, this branch's workflow asks the
dashboard workflow to rebuild:
- A commit message containing `[beta]` publishes a beta image.
- Any other commit publishes a stable image.
