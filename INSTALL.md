# CastNexus Installation Guide

If you have never used Docker before, start here:

**[Beginner Docker Setup Guide](docs/BEGINNER-SETUP.md)**

It covers installing Docker, finding your host IP, creating `.env`, starting CastNexus, checking logs, OBS setup, console mode, Windows Docker Desktop, Raspberry Pi, updates, and common errors.

---

## Which install should I use?

| Method | Best for | Difficulty |
|---|---|---|
| Docker | Raspberry Pi, Linux PC, home server, VPS, full CastNexus features | Recommended |
| Desktop | Windows/Linux desktop UI without managing Docker manually | Easy |
| CLI | Headless/server users who do not want the Docker stack | Advanced |

For the full console DNS/interception workflow, use **Docker Engine on Linux**.

---

# 1. Docker — recommended

The repository uses `docker-compose.yml`.

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

# 3. Docker GPU acceleration — optional

CPU encoding works without these overlays.

## NVIDIA

Requires NVIDIA Container Toolkit:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-nvidia.yml \
  up -d
```

## VAAPI

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-vaapi.yml \
  up -d
```

Get the normal CPU install working first before adding GPU passthrough.

---

# 4. Desktop app

**Best for:** Windows/Linux users who want a native launcher and setup UI.

Build from source:

```bash
npm --prefix electron install
npm --prefix electron run build
```

Release builds may also be available from the repository's GitHub Releases page.

On first launch:

1. open CastNexus Desktop
2. complete setup
3. open CastNexus Studio
4. create a profile
5. configure sources and destinations

Desktop does not provide the same full Linux DNS/ARP console interception environment as the Docker/Linux deployment.

---

# 5. CLI launcher

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

# 6. Updating Docker

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

# 7. Quick troubleshooting

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

Example for the dashboard:

```bash
sudo ss -lntup | grep ':8090'
```

Example for console DNS:

```bash
sudo ss -lntup | grep ':53 '
```

## Stop CastNexus

```bash
docker compose down
```

## Restart CastNexus

```bash
docker compose restart
```

---

## Detailed docs

- [Beginner Docker setup](docs/BEGINNER-SETUP.md)
- [Hosted OAuth](docs/HOSTED-OAUTH.md)
- [VPS console gateway](docs/VPS-CONSOLE-GATEWAY.md)
- [VRChat HLS](docs/HLS-VRCHAT.md)
- [GPU / Twitch recordings / YouTube](docs/GPU-TWITCH-RECORDINGS-YOUTUBE.md)
- [VOD / reruns](docs/VOD-RERUNS.md)
