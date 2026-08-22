# CastNexus Installation Guide

Choose your deployment method:

## 1. Desktop App (Electron) - Recommended for most users

**Best for:** Windows/Linux desktop with native app experience, automatic updates, GUI settings.

### Installation

```bash
npm --prefix electron install
npm --prefix electron run build
# Output: electron/dist/CastNexus-Studio-Setup.exe (Windows) or .AppImage (Linux)
```

### First Launch

1. Run the installer
2. Launch CastNexus Studio
3. Complete the setup wizard (Twitch OAuth, RTMP settings)
4. Dashboard opens automatically at http://127.0.0.1:8090

### Features

✓ Native window with sidebar
✓ Settings stored locally (no .env needed)
✓ Auto-detects Chromium/FFmpeg
✓ Music 24/7 support
✓ No manual configuration required

---

## 2. CLI Launcher - For headless/server deployments

**Best for:** SSH servers, Docker containers, Linux VPS, CI/CD environments.

### Installation

```bash
npm --prefix cli install
npm --prefix cli start --  # Interactive setup
# Or use .env file (see CLI README)
```

### First-time Setup

```bash
npm --prefix cli run setup
# Follow prompts for Twitch OAuth and RTMP settings
```

### Using with .env

Create `.env` in the working directory:
```env
DASHBOARD_PORT=8090
TWITCH_CLIENT_ID=your_id
TWITCH_CLIENT_SECRET=your_secret
STATE_FILE=/home/user/.castnexus/state.json
```

Then:
```bash
npm --prefix cli start
```

### Features

✓ No GUI, pure CLI
✓ Supports both .env and electron-store configs
✓ Lightweight (perfect for servers)
✓ Same features as Desktop

---

## 3. Docker Compose - For VPS/remote deployments

**Best for:** VPS providers (Linode, DigitalOcean, Hetzner), multi-service setups, public streaming.

### Installation

```bash
docker-compose -f compose.yaml up -d
```

### Configuration

Create `.env` in the working directory:
```env
DASHBOARD_PORT=8090
PI_IP=192.168.1.100
TWITCH_CLIENT_ID=your_id
TWITCH_CLIENT_SECRET=your_secret
MEDIA_RTMP_ORIGIN=rtmp://127.0.0.1:1935
# ... other settings ...
```

Then:
```bash
docker-compose -f compose.yaml -f docker-compose.vps.yml up -d
```

### For VPS with public DNS/intercept:

```bash
docker-compose -f compose.yaml -f docker-compose.vps.yml up -d
# Also configure intercept service for network routing
```

### Features

✓ Fully containerized
✓ Compatible with existing docker-compose setup
✓ MediaMTX, DNS, and intercept services included
✓ .env configuration
✓ Easy deployment to VPS

---

## Installation Summary Table

| Feature | Desktop (Electron) | CLI | Docker |
|---------|-------------------|-----|--------|
| GUI | ✓ | ✗ | Web UI |
| Setup Wizard | ✓ | ✓ | Manual .env |
| .env Support | ✗ | ✓ | ✓ |
| Auto-update | ✓ | ✗ | Manual |
| No .env needed | ✓ | ✓ | ✗ |
| Headless | ✗ | ✓ | ✓ |
| Package Size | ~400MB | ~150MB | ~2GB (image) |
| Settings Storage | Local JSON | Local JSON or .env | .env only |

---

## Building Standalone Binaries

### Desktop (Electron)
```bash
npm --prefix electron run build
# Output: electron/dist/
```

### CLI (pkg)
```bash
npm --prefix cli run pkg:build
# Output: cli/dist/castnexus-cli (Windows/Linux binaries)
```

---

## Troubleshooting

### "Chromium not found"
- **Desktop/CLI:** Automatically detects Chrome/Edge/Chromium. If not found, install Chromium or set `PUPPETEER_EXECUTABLE_PATH`
- **Docker:** Chromium is included in the image

### "MediaMTX failed to start"
- **Desktop/CLI:** Download from [bluenviron/mediamtx](https://github.com/bluenviron/mediamtx/releases)
- **Docker:** MediaMTX is bundled in the container

### Settings not saving
- **Desktop:** Check `~/.castnexus/` directory permissions
- **CLI:** Check `.env` file permissions or `~/.castnexus/` for electron-store
- **Docker:** Check volume mounts in docker-compose.yml

### Port already in use
Set a different port:
- **Desktop/CLI:** `--prefix electron/cli` then modify .env or setup wizard
- **Docker:** Adjust `DASHBOARD_PORT` in .env before running compose

---

## Full Setup Examples

### Desktop (Windows)
1. Download installer from releases
2. Run installer
3. Launch app → Setup wizard
4. Done!

### CLI on Linux VPS
```bash
git clone https://github.com/NekoSuneProjects/CastNexus.git
cd CastNexus
npm --prefix cli install
npm --prefix cli run setup
npm --prefix cli start
```

### Docker on VPS
```bash
git clone https://github.com/NekoSuneProjects/CastNexus.git
cd CastNexus
cp .env.example .env  # Edit with your settings
docker-compose -f compose.yaml -f docker-compose.vps.yml up -d
```

See individual folders for detailed documentation:
- [`electron/`](electron/) - Desktop app docs
- [`cli/`](cli/) - CLI launcher docs
- [`dashboard/`](dashboard/) - Web server docs
