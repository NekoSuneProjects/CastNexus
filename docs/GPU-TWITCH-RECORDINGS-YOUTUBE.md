# GPU encoding, Twitch discovery, MediaMTX recordings and YouTube uploads

This document covers the CastNexus broadcast-storage pipeline added after the profile/VOD work.

## 1. Automatic hardware encoder detection

CastNexus asks the installed FFmpeg which H.264 encoders it advertises, then performs a real one-frame encode probe before selecting hardware.

Current candidates are:

- NVIDIA NVENC (`h264_nvenc`)
- Intel Quick Sync (`h264_qsv`)
- Linux VAAPI (`h264_vaapi`)
- AMD AMF on Windows (`h264_amf`)
- Apple VideoToolbox on macOS (`h264_videotoolbox`)
- V4L2 M2M on supported Linux/SoC systems (`h264_v4l2m2m`)
- CPU fallback: `libx264`

`CASTNEXUS_VIDEO_ENCODER=auto` is the recommended setting.

The selected encoder is used for work that actually requires re-encoding:

- forced 16:9 / 9:16 destination layouts
- uploaded/YouTube VOD normalization
- the headless CastNexus compositor
- the 24/7 music compositor

Twitch live HLS and Twitch VODs are stream-copied where possible instead of wasting GPU/CPU on an unnecessary encode.

If a selected hardware encoder exits almost immediately at runtime, CastNexus retries the affected encode with CPU x264. This protects against cases where FFmpeg advertises an encoder but the device/driver later becomes unavailable.

### Desktop

Desktop uses the host FFmpeg installation. If the host FFmpeg can successfully use NVENC/QSV/AMF/VAAPI/etc., CastNexus selects it automatically. No separate desktop GPU setting is required.

FFmpeg still needs to be installed and available on `PATH` for desktop releases.

### Docker: Intel / AMD Linux graphics

The base Compose file does not blindly mount `/dev/dri` because that would make Compose fail on hosts without the device.

Use the optional override on a machine with `/dev/dri`:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-vaapi.yml \
  up -d
```

The default VAAPI render device is:

```text
/dev/dri/renderD128
```

Override it with `VAAPI_DEVICE` when needed.

### Docker: NVIDIA

Install NVIDIA Container Toolkit on the Docker host, then run:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-nvidia.yml \
  up -d
```

The override gives the dashboard and 24/7 music worker GPU access. CastNexus still probes NVENC and falls back to CPU if the runtime/driver is not usable.

---

## 2. Twitch live is verified before HLS/m3u8 relay

CastNexus uses Twitch Helix before starting a Twitch live relay.

Flow:

```text
Twitch API GET /helix/streams
        |
        +-- offline -> stop here; no yt-dlp, no FFmpeg relay
        |
        +-- live -> resolve current Twitch HLS/m3u8 with yt-dlp
                     |
                     v
                relay/<pc-key>
                     |
                     v
                 MediaMTX
                     |
                     v
            CastNexus destinations
```

The Twitch API check prevents CastNexus from repeatedly starting an extractor against an offline channel.

OBS still publishes to:

```text
live/<pc-key>
```

Twitch HLS/VOD reruns publish to:

```text
relay/<pc-key>
```

so the two producers never own the same MediaMTX publisher path.

---

## 3. Automatic Twitch VOD discovery after login

When a user signs into CastNexus with Twitch, CastNexus asynchronously requests that broadcaster's archive VODs from Twitch Helix and stores a short-lived catalog cache.

The Reruns / VOD page has a dedicated **My Twitch cloud VODs** section.

These entries:

- come from the authenticated Twitch user's `user_id`
- do not consume CastNexus disk space
- can be played once or looped through the existing rerun path
- refresh automatically after the cache TTL and can also be refreshed manually

This is separate from the profile's manually added remote/uploaded rerun library.

---

## 4. Native MediaMTX recording

CastNexus records the stable account program path:

```text
public/<twitch-login>
```

That is intentional. The path follows whichever source is currently driving the account, so a recording can contain PC/OBS, console, or a generated rerun without exposing raw ingest keys.

Recording is disabled by default. The dashboard uses the local MediaMTX Control API to hot-patch the exact account path and toggle `record` on/off.

The MediaMTX configuration uses:

```yaml
pathDefaults:
  record: no
  recordPath: /recordings/%path/%Y-%m-%d_%H-%M-%S-%f
  recordFormat: fmp4
  recordPartDuration: 1s
  recordSegmentDuration: 1h
  recordDeleteAfter: 0s
```

`recordDeleteAfter: 0s` means CastNexus does not silently expire recordings. The user explicitly controls deletion from the Studio UI.

### Docker storage

The same host directory is mounted two ways:

```text
MediaMTX:  /recordings
Dashboard: /app/data/recordings
Host:      ./dashboard/data/recordings
```

MediaMTX writes the files. CastNexus recursively measures the actual file sizes and displays disk usage in the Reruns / VOD page.

### Desktop storage

Desktop stores recordings under:

```text
~/.castnexus/recordings/
```

(or the configured `CASTNEXUS_DATA_DIR`).

### Recording controls

The Studio provides:

- recording on/off
- measured disk usage
- segment count
- playback through an authenticated CastNexus proxy
- delete one segment
- delete all recordings for the signed-in account

MediaMTX's playback/control services listen on loopback only; they are not intended to be exposed directly to the internet.

---

## 5. Upload a MediaMTX recording to YouTube

CastNexus can upload a recorded program directly to YouTube using YouTube Data API v3.

### Google Cloud setup

1. Create/select a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen.
4. Create an **OAuth 2.0 Web application** client.
5. Add the exact redirect URL, for example:

```text
http://192.168.1.50:8090/auth/youtube/callback
```

6. Configure CastNexus:

```dotenv
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://192.168.1.50:8090/auth/youtube/callback
```

The Studio then exposes **Connect YouTube**. CastNexus requests only:

```text
https://www.googleapis.com/auth/youtube.upload
```

The Google refresh token is encrypted before being written to `state.json`; it is not stored as plaintext.

### Upload flow

```text
MediaMTX recording segment
        |
        v
MediaMTX playback API assembles MP4
        |
        v
temporary local MP4
        |
        v
YouTube resumable upload session
        |
        v
videos.insert / resumable PUT
        |
        v
temporary file deleted
```

The Studio lets the user choose title, description, tags, category and privacy.

YouTube can force uploads from unverified API projects to **Private** until the project completes the required audit. CastNexus warns about that in the upload UI.

---

## 6. Upload quota whitelist / guard

CastNexus does not pretend it can read Google Cloud Console's current project quota from the YouTube API.

Instead it provides two local controls.

### Optional account whitelist

```dotenv
YOUTUBE_UPLOAD_ALLOWLIST=
```

For a multi-user/self-hosted instance, provide comma-separated Twitch user IDs and/or Twitch login names:

```dotenv
YOUTUBE_UPLOAD_ALLOWLIST=18028479,nekosunevr,anotheruser
```

Use `*` to explicitly allow every authenticated CastNexus account.

An empty value is intentionally convenient for a normal single-user self-hosted install and does not block that owner from using their own configured Google API project.

### Daily soft limit

```dotenv
YOUTUBE_UPLOAD_DAILY_SOFT_LIMIT=90
```

Current YouTube documentation gives `videos.insert` its own Video Uploads quota bucket with a default of 100 upload calls per day. CastNexus defaults to 90 attempts/day so it leaves some headroom.

This is a **local soft guard**, not a replacement for Google's quota enforcement. If your Google project is approved for different quota, change this value to match your own policy.

The UI displays today's CastNexus upload attempts, local limit and remaining local allowance.

---

## Security / ownership

- Twitch HLS/manual remote rerun actions keep the existing ownership/authorization confirmation.
- Automatically discovered Twitch VODs come only from the Twitch user ID that signed into CastNexus.
- MediaMTX recording playback is proxied through the authenticated dashboard rather than exposing the playback service publicly.
- YouTube refresh tokens are encrypted at rest in CastNexus state.
- YouTube uploads can be limited to a local Twitch-account whitelist.
- Raw Twitch stream keys remain separate from the generated CastNexus PC key.
