# CastNexus Installation Guide

If you have never used Docker before, start here:

**[Beginner Docker Setup Guide](docs/BEGINNER-SETUP.md)**

For hardware sizing, CPU/GPU encoding and understanding what each Docker service does:

**[Hardware, Docker & Encoding Guide](docs/HARDWARE-ENCODING.md)**

For advanced `.env` tuning:

**[Advanced Configuration Guide](docs/ADVANCED-CONFIGURATION.md)**

---

## Which install should I use?

| Method | Best for | Difficulty |
|---|---|---|
| Docker | Raspberry Pi, Linux PC, home server, VPS, full CastNexus features | Recommended |
| Desktop | Windows/Linux desktop UI without managing Docker manually | Easy |
| CLI | Headless/server users who do not want the Docker stack | Advanced |

For the full console DNS/interception workflow, use **Docker Engine on Linux**.

---

# Hardware requirements at a glance

CastNexus does not have one fixed CPU requirement because **routing/copying a stream is much cheaper than re-encoding it**.

A Source-layout destination normally copies H.264 video and only normalizes audio. Landscape/Vertical destinations, browser compositor scenes, Music 24/7 and some VOD work can require a full video encode.

Conservative starting points:

| Workload | CPU | RAM | Notes |
|---|---:|---:|---|
| Basic Source-layout restream/routing | 2 cores minimum, 4 recommended | 4 GB minimum, 8 GB recommended | Lowest CPU because video can be copied |
| CPU-only generated/transformed stream | 4 fast cores minimum | 8 GB | Keep CPU safe mode enabled |
| CPU-only host shared with other services | 6-8 modern cores | 8-16 GB | Leave real CPU headroom |
| CPU-only 720p30 generated/transformed output | 6-8 modern dedicated cores | 8-16 GB | Measure actual workload |
| CPU-only 1080p30 compositor/multiple transforms | 12+ fast cores | 16 GB+ | GPU strongly recommended instead |
| GPU/iGPU accelerated server | 4 cores minimum, 6-8 recommended | 8-16 GB | Requires a working supported H.264 hardware encoder |
| Raspberry Pi 5 | Pi 5 / 64-bit OS | 8 GB preferred | Best with Source routing or CPU safe mode |

A six-core machine can still reach 95-100% if it is also running game servers, media transcodes, other Docker containers, or several CastNexus encode jobs. Shared VPS `vCPU` performance can also be much lower than the same core count on a dedicated desktop/server CPU.

Read the full sizing explanation before buying/renting hardware:

**[docs/HARDWARE-ENCODING.md](docs/HARDWARE-ENCODING.md)**

---

# What Docker starts

Normal CastNexus Docker mode runs:

- `castnexus-dashboard` — Studio/API, FFmpeg, Chromium compositor, Music 24/7, VOD and destination processing
- `castnexus-mediamtx` — RTMP/RTSP/HLS/WebRTC/SRT ingest/playback router
- `castnexus-mediamtx-vrchat` — separate VRChat/AVPro-compatible MPEG-TS HLS server
- `castnexus-vrchat-relay` — compatible H.264/AAC relay into the VRChat MediaMTX instance

Optional `console` profile also starts:

- `castnexus-dns`
- `castnexus-intercept`

The normal OBS/PC/Music install does **not** need the DNS/interception containers.

Persistent data is bind-mounted under:

```text
dashboard/data/
```

so normal container replacement does not delete your Studio state/music/VOD/recording files.

---

# 1. Docker — recommended

The repository uses `docker-compose.yml` and Docker Compose v2 (`docker compose` with a space).

## Normal PC / OBS / Music install

```bash
git clone https://github.com/NekoSuneProjects/CastNexus.git
cd CastNexus
cp .env.example .env
nano .env
```

Set the real LAN IP of the CastNexus machine:

```dotenv
PI_IP=192.168.1.50
```

For normal PC/Music use, leave these blank:

```dotenv
TARGET_IPS=
GATEWAY_IP=
```

Keep automatic encoder detection unless troubleshooting:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
CASTNEXUS_CPU_SAFE_MODE=auto
```

The hosted OAuth broker is enabled by default, so most users can leave Twitch/Google client IDs and secrets empty.

Start CastNexus:

```bash
docker compose pull
docker compose up -d
```

Open:

```text
http://YOUR_CASTNEXUS_IP:8090
```

Check status:

```bash
docker compose ps
```

Check logs:

```bash
docker compose logs --tail=100 dashboard
```

Check live resource usage:

```bash
docker stats
```

## Included helper script

Once `.env` exists and has been edited:

```bash
chmod +x install.sh
./install.sh
```

The helper starts normal mode when `TARGET_IPS` is blank, or console mode when console target addresses have been configured.

---

# 2. Docker console capture — optional

Console capture is not required for OBS, Music 24/7, VODs, overlays, or normal restreaming.

Set:

```dotenv
PI_IP=192.168.1.50
TARGET_IPS=192.168.1.100
GATEWAY_IP=192.168.1.1
INTERCEPT_MODE=lan
```

Then run:

```bash
docker compose --profile console pull
docker compose --profile console up -d
```

Set the console's Primary DNS to the CastNexus host IP.

See the beginner guide for the full walkthrough and troubleshooting:

**[docs/BEGINNER-SETUP.md](docs/BEGINNER-SETUP.md)**

For the public/VPS console gateway, see:

**[docs/VPS-CONSOLE-GATEWAY.md](docs/VPS-CONSOLE-GATEWAY.md)**

---

# 3. CPU encoding

A GPU is **not required**.

CastNexus uses `libx264` when no working hardware encoder is available.

Recommended automatic behavior:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
CASTNEXUS_CPU_SAFE_MODE=auto
```

Force CPU for diagnosis:

```dotenv
CASTNEXUS_VIDEO_ENCODER=cpu
X264_PRESET=ultrafast
```

CPU-only safe-mode default target:

```dotenv
CASTNEXUS_CPU_SAFE_WIDTH=960
CASTNEXUS_CPU_SAFE_HEIGHT=540
CASTNEXUS_CPU_SAFE_FPS=20
CASTNEXUS_CPU_JPEG_QUALITY=60
```

For a heavily loaded/shared server:

```dotenv
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=640
CASTNEXUS_CPU_SAFE_HEIGHT=360
CASTNEXUS_CPU_SAFE_FPS=10
CASTNEXUS_CPU_JPEG_QUALITY=50
X264_PRESET=ultrafast
```

Source-layout destinations are much cheaper because CastNexus normally copies video instead of re-encoding it.

Full CPU tuning guide:

**[docs/HARDWARE-ENCODING.md](docs/HARDWARE-ENCODING.md)**

---

# 4. Docker GPU acceleration — optional

Hardware acceleration reduces H.264 encode load but **does not make CPU usage zero**. Chromium scene rendering, audio processing, filters, Node.js, MediaMTX and network handling still use CPU/RAM.

Keep encoder selection automatic unless troubleshooting:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
```

CastNexus checks FFmpeg and performs a real one-frame encode probe. If hardware fails, it falls back to CPU x264.

## NVIDIA

First make sure this works on the host:

```bash
nvidia-smi
```

Install/configure NVIDIA Container Toolkit, then start with:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-nvidia.yml \
  up -d
```

Optional diagnostic force:

```dotenv
CASTNEXUS_VIDEO_ENCODER=nvenc
```

## Intel / AMD Linux graphics

Check:

```bash
ls -l /dev/dri
```

Then:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-vaapi.yml \
  up -d
```

Typical device:

```dotenv
VAAPI_DEVICE=/dev/dri/renderD128
```

CastNexus can probe Intel Quick Sync (`qsv`) and Linux VAAPI depending on the host/driver/FFmpeg combination.

Full GPU setup/tuning/troubleshooting:

**[docs/HARDWARE-ENCODING.md](docs/HARDWARE-ENCODING.md)**

---

# 5. Advanced `.env` configuration

Do not guess at environment variables from source code. The supported advanced reference is now:

**[docs/ADVANCED-CONFIGURATION.md](docs/ADVANCED-CONFIGURATION.md)**

It covers:

- stable/beta channels
- dashboard/network settings
- hosted versus custom OAuth
- login allowlists
- CPU/GPU encoder forcing
- x264/NVENC/QSV/AMF presets
- CPU safe mode
- destination FPS/bitrate/buffer/preset
- browser compositor GPU/size/FPS/JPEG quality
- Music 24/7 render sizing
- VOD settings
- cover-art providers
- YouTube upload configuration
- LAN console interception
- VPS/public DNS/RTMP settings
- low-power CPU/VPS/GPU example profiles

After changing `.env`, apply it with:

```bash
docker compose up -d --force-recreate
```

Check that a value reached the container:

```bash
docker compose exec dashboard printenv CASTNEXUS_VIDEO_ENCODER
```

---

# 6. Desktop app

**Best for:** Windows/Linux users who want a native launcher and setup UI.

Build from source:

```bash
npm --prefix electron install
npm --prefix electron run build
```

Release builds may also be available from the repository's GitHub Releases page.

Desktop does not provide the same full Linux DNS/ARP console interception environment as the Docker/Linux deployment.

---

# 7. CLI launcher

**Best for:** headless/server deployments where you deliberately want the Node.js CLI instead of the Docker stack.

```bash
git clone https://github.com/NekoSuneProjects/CastNexus.git
cd CastNexus
npm --prefix cli install
npm --prefix cli run setup
npm --prefix cli start
```

The Docker deployment is still the recommended path for most self-hosted users because it includes the complete service stack.

---

# 8. Updating Docker

Stable channel:

```bash
git pull
docker compose pull
docker compose up -d
```

Console mode:

```bash
git pull
docker compose --profile console pull
docker compose --profile console up -d
```

Beta channel users can set:

```dotenv
CASTNEXUS_IMAGE_TAG=beta
CASTNEXUS_CHANNEL=beta
```

Stable users should keep:

```dotenv
CASTNEXUS_IMAGE_TAG=latest
CASTNEXUS_CHANNEL=stable
```

---

# 9. Resource monitoring

Check all container usage:

```bash
docker stats
```

Check host CPU/RAM/processes:

```bash
htop
```

Check system load:

```bash
uptime
```

Check disk:

```bash
df -h
du -sh dashboard/data
```

If the whole host is at 95% CPU, compare `docker stats` with `htop` before assuming CastNexus is responsible for all of it.

---

# 10. Quick troubleshooting

## Docker is missing

```bash
docker --version
docker compose version
```

If either command is unavailable, install Docker Engine + the Compose v2 plugin first.

## Permission denied on Docker socket

```bash
sudo usermod -aG docker "$USER"
```

Then sign out and back in.

## Dashboard does not open

```bash
docker compose ps
docker compose logs --tail=200 dashboard
```

## Port already in use

Dashboard:

```bash
sudo ss -lntup | grep ':8090'
```

Console DNS:

```bash
sudo ss -lntup | grep ':53 '
```

## Stop CastNexus

```bash
docker compose down
```

## Restart without changing config

```bash
docker compose restart
```

## Apply changed `.env`

```bash
docker compose up -d --force-recreate
```

---

## Detailed docs

- [Beginner Docker setup](docs/BEGINNER-SETUP.md)
- [Hardware, Docker & encoding requirements](docs/HARDWARE-ENCODING.md)
- [Advanced `.env` configuration](docs/ADVANCED-CONFIGURATION.md)
- [Hosted OAuth](docs/HOSTED-OAUTH.md)
- [VPS console gateway](docs/VPS-CONSOLE-GATEWAY.md)
- [VRChat HLS](docs/HLS-VRCHAT.md)
- [GPU / Twitch recordings / YouTube](docs/GPU-TWITCH-RECORDINGS-YOUTUBE.md)
- [VOD / reruns](docs/VOD-RERUNS.md)
