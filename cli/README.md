# CastNexus CLI

Lightweight command-line launcher for CastNexus. No GUI, just a terminal interface for headless/server deployments.

## Installation

```bash
cd cli
npm install
```

## First-time Setup

```bash
npm run setup
```

This will prompt you for:
- Twitch Client ID & Secret
- Twitch OAuth Redirect URI
- Dashboard port (default: 8090)

Settings are stored in `~/.castnexus/castnexus-cli.json` (never needs manual editing).

## Running

```bash
npm start
```

Or globally if packaged:
```bash
castnexus-cli
```

The dashboard will be available at `http://localhost:8090`.

## Building Standalone Binary

```bash
npm run pkg:build
```

Produces `dist/castnexus-cli` (Windows/Linux binaries).

## Configuration

### Option 1: electron-store (interactive setup, no .env)

```bash
npm run setup
```

Settings stored in `~/.castnexus/castnexus-cli.json`. Perfect for first-time users.

### Option 2: .env file (traditional method)

Create a `.env` file in the working directory:

```env
DASHBOARD_PORT=8090
STATE_FILE=/path/to/data/state.json
MUSIC_DIR=/path/to/data/music
VOD_DIR=/path/to/data/vod
RECORDINGS_DIR=/path/to/data/recordings
TWITCH_CLIENT_ID=your_id
TWITCH_CLIENT_SECRET=your_secret
TWITCH_REDIRECT_URI=http://localhost:8090/auth/twitch/callback
PI_IP=192.168.1.100
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

Then run:
```bash
npm start
```

CLI loads `.env` if present, falls back to electron-store settings, then uses defaults.
