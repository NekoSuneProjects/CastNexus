# CastNexus Advanced Configuration

This document is the advanced reference for editing CastNexus `.env` settings.

If you are installing CastNexus for the first time, start with [`BEGINNER-SETUP.md`](BEGINNER-SETUP.md). For hardware sizing and CPU/GPU encoding, read [`HARDWARE-ENCODING.md`](HARDWARE-ENCODING.md).

> [!IMPORTANT]
> You do **not** need to change most of these values. The recommended starting point is to copy `.env.example`, set the correct host IP, leave the encoder on `auto`, and only tune a value when you understand the reason.

---

# 1. How `.env` works

Docker Compose reads `.env` when it parses `docker-compose.yml`.

Example:

```dotenv
DASHBOARD_PORT=8090
CASTNEXUS_VIDEO_ENCODER=auto
```

The Compose file passes the supported values into the CastNexus containers.

After changing `.env`, use:

```bash
docker compose up -d --force-recreate
```

For NVIDIA:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-nvidia.yml \
  up -d --force-recreate
```

For Intel/AMD Linux graphics:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-vaapi.yml \
  up -d --force-recreate
```

A plain:

```bash
docker compose restart
```

only restarts existing containers and should not be relied on to apply changed container configuration.

Check the final Compose configuration with:

```bash
docker compose config
```

Be careful: this command can display resolved environment values. Do not paste the result publicly without checking it for secrets.

---

# 2. Stable versus beta channel

Stable:

```dotenv
CASTNEXUS_IMAGE_TAG=latest
CASTNEXUS_CHANNEL=stable
```

Beta:

```dotenv
CASTNEXUS_IMAGE_TAG=beta
CASTNEXUS_CHANNEL=beta
```

After changing image channel:

```bash
docker compose pull
docker compose up -d
```

For production installations, stable is recommended.

---

# 3. Host identity and dashboard

## `PI_IP`

```dotenv
PI_IP=192.168.1.50
```

Despite the historical variable name, this is the CastNexus host address and is not limited to Raspberry Pi.

For a LAN install use the LAN IP reachable by OBS/phones/consoles.

Do not use `127.0.0.1` if other devices need to connect.

## `DASHBOARD_PORT`

```dotenv
DASHBOARD_PORT=8090
```

Changes the CastNexus Studio HTTP port.

Example:

```dotenv
DASHBOARD_PORT=8095
```

Then Studio becomes:

```text
http://HOST_IP:8095
```

Make sure any OAuth redirect configuration/reverse proxy is updated when changing public URLs.

## `RECONNECT_GRACE_MS`

```dotenv
RECONNECT_GRACE_MS=3600000
```

How long CastNexus keeps output state ready while an input reconnects.

Default:

```text
3,600,000 ms = 1 hour
```

Example 10 minutes:

```dotenv
RECONNECT_GRACE_MS=600000
```

---

# 4. Hosted OAuth versus your own credentials

Recommended default:

```dotenv
CASTNEXUS_OAUTH_BROKER_URL=https://castnexus.nekosunevr.co.uk/oauth
```

This uses the CastNexus oauth-broker service so the normal user does not need provider client secrets on the installation. `CASTNEXUS_OAUTH_BROKER_URL` is required and must be an `https://` URL - there is no local/BYO-credential mode.

---

# 5. Self-hosting your own oauth-broker

To deliberately use your own Twitch/Google developer applications instead of the official public broker, self-host your own oauth-broker instance (`docker-compose.oauth-broker.yml`) and point `CASTNEXUS_OAUTH_BROKER_URL` at it. See the "Self-hosting your own oauth-broker" section of [INSTALL.md](../INSTALL.md) and [docs/HOSTED-OAUTH.md](HOSTED-OAUTH.md) for the full setup.

Do not commit `.env` containing secrets to Git.

---

# 6. Account registration/security

## `DISABLE_REGISTRATION`

```dotenv
DISABLE_REGISTRATION=false
```

When `false`, a successfully authenticated user may create a CastNexus account.

For an internet-accessible private instance, consider closing registration after the owner account is established.

```dotenv
DISABLE_REGISTRATION=true
```

## `ALLOWED_TWITCH_LOGINS`

Restrict sign-in/registration to specific Twitch login names.

Example:

```dotenv
ALLOWED_TWITCH_LOGINS=creatorone,creatortwo
```

This is the safest way to bootstrap a fresh closed instance because the named accounts may still sign in while unlisted accounts are refused.

> [!WARNING]
> Setting `DISABLE_REGISTRATION=true` on a completely fresh instance without an allowlisted account can lock everybody out.

---

# 7. Encoder selection

Recommended:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
```

CastNexus checks FFmpeg's advertised encoders and performs a real encode probe before accepting hardware acceleration.

Supported values include:

```text
auto
cpu
x264
libx264
software
nvenc
h264_nvenc
qsv
h264_qsv
vaapi
h264_vaapi
amf
h264_amf
videotoolbox
h264_videotoolbox
v4l2m2m
h264_v4l2m2m
```

Examples:

Force CPU:

```dotenv
CASTNEXUS_VIDEO_ENCODER=cpu
```

Force NVIDIA:

```dotenv
CASTNEXUS_VIDEO_ENCODER=nvenc
```

Force Intel Quick Sync:

```dotenv
CASTNEXUS_VIDEO_ENCODER=qsv
```

Force Linux VAAPI:

```dotenv
CASTNEXUS_VIDEO_ENCODER=vaapi
```

If a hardware probe fails, CastNexus falls back to CPU x264.

---

# 8. Linux VAAPI device

Default:

```dotenv
VAAPI_DEVICE=/dev/dri/renderD128
```

Inspect host devices:

```bash
ls -l /dev/dri
```

If the render device is different, change it accordingly.

The device also needs to be mapped into Docker by using:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-vaapi.yml \
  up -d
```

---

# 9. Hardware encoder preset controls

These are advanced knobs. Keep defaults unless you are testing encoder behavior.

NVIDIA:

```dotenv
NVENC_PRESET=p4
```

Intel QSV:

```dotenv
QSV_PRESET=veryfast
```

AMD AMF:

```dotenv
AMF_QUALITY=speed
```

These settings affect hardware encoding only when the matching encoder is selected.

---

# 10. CPU x264 preset

Global CPU preset override:

```dotenv
X264_PRESET=ultrafast
```

`ultrafast` reduces CPU load but has worse compression efficiency.

`veryfast` uses more CPU but normally improves compression at the same bitrate.

On CPU-only live servers, stability/realtime performance is more important than selecting a slow preset.

---

# 11. CPU safe mode

Recommended CPU-only default:

```dotenv
CASTNEXUS_CPU_SAFE_MODE=auto
```

Behavior:

```text
auto  -> enable safe mode when no working hardware encoder is selected
true  -> always enable the clamp
false -> do not apply the CPU safe clamp
```

Safe render dimensions:

```dotenv
CASTNEXUS_CPU_SAFE_WIDTH=960
CASTNEXUS_CPU_SAFE_HEIGHT=540
CASTNEXUS_CPU_SAFE_FPS=20
CASTNEXUS_CPU_JPEG_QUALITY=60
```

On vertical layouts CastNexus swaps the width/height appropriately.

For an overloaded host:

```dotenv
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=640
CASTNEXUS_CPU_SAFE_HEIGHT=360
CASTNEXUS_CPU_SAFE_FPS=10
CASTNEXUS_CPU_JPEG_QUALITY=50
X264_PRESET=ultrafast
```

## Legacy Pi names

These remain available for compatibility:

```dotenv
CASTNEXUS_PI_SAFE_MODE=auto
CASTNEXUS_PI_SAFE_WIDTH=960
CASTNEXUS_PI_SAFE_HEIGHT=540
CASTNEXUS_PI_SAFE_FPS=20
CASTNEXUS_PI_JPEG_QUALITY=60
```

The newer `CPU_*` values take priority when both are set.

---

# 12. RTMP input buffering

```dotenv
RTMP_INPUT_QUEUE=1024
```

This becomes FFmpeg's input thread queue size for live input.

Do not increase this just to hide an overloaded encoder. A larger queue can increase memory use and allow more latency to accumulate when processing cannot keep up.

For a VPS with short bursts/jitter, a value such as:

```dotenv
RTMP_INPUT_QUEUE=2048
```

may be useful, but diagnose CPU/realtime problems first.

---

# 13. Destination audio

Default:

```dotenv
DESTINATION_AUDIO_BITRATE=128k
DESTINATION_AUDIO_RATE=44100
```

CastNexus normally produces stereo AAC for destination output.

Example higher AAC bitrate:

```dotenv
DESTINATION_AUDIO_BITRATE=160k
```

Avoid excessive audio bitrates unless the destination platform supports them.

---

# 14. Destination video settings

These affect destination jobs that require video encoding, such as forced landscape/vertical layouts.

```dotenv
DESTINATION_FPS=30
DESTINATION_VIDEO_BITRATE=6000k
DESTINATION_VIDEO_MAXRATE=6000k
DESTINATION_VIDEO_BUFSIZE=12000k
DESTINATION_X264_PRESET=veryfast
```

## `DESTINATION_FPS`

Requested transformed output FPS.

CPU safe mode can clamp the actual FPS lower.

Example low-power server:

```dotenv
DESTINATION_FPS=20
```

## Bitrate / maxrate / bufsize

Example 4 Mbps profile:

```dotenv
DESTINATION_VIDEO_BITRATE=4000k
DESTINATION_VIDEO_MAXRATE=4000k
DESTINATION_VIDEO_BUFSIZE=8000k
```

Changing bitrate does not magically solve a CPU bottleneck. Resolution, FPS, filters and x264 preset usually matter more for CPU usage.

## Destination x264 preset

```dotenv
DESTINATION_X264_PRESET=ultrafast
```

Used for software destination encoding unless the global `X264_PRESET` overrides it.

---

# 15. Source layout is intentionally different

When a destination uses the CastNexus **Source** layout, compatible video is copied instead of re-encoded.

Therefore settings such as:

```text
DESTINATION_VIDEO_BITRATE
DESTINATION_VIDEO_MAXRATE
DESTINATION_VIDEO_BUFSIZE
DESTINATION_X264_PRESET
```

primarily matter when a destination is actually being transformed/re-encoded.

If CPU usage is high, changing unnecessary destinations back to Source is often more effective than tuning bitrate.

---

# 16. Browser compositor settings

The compositor renders CastNexus browser scenes/overlays and sends those frames to FFmpeg.

## GPU mode

```dotenv
COMPOSITOR_GPU=auto
```

Values:

```text
auto
true
false
```

`auto` is recommended. It enables the GPU browser path when CastNexus has selected a working hardware encoder and uses software rendering on CPU-only hosts.

> [!NOTE]
> Hardware H.264 encoding does not eliminate all compositor CPU use. Chromium still has to load/layout/render the scene and CastNexus still moves frames/audio between processes.

## Size/FPS

```dotenv
COMPOSITOR_WIDTH=1280
COMPOSITOR_HEIGHT=720
COMPOSITOR_FPS=30
```

For GPU-backed 1080p:

```dotenv
COMPOSITOR_WIDTH=1920
COMPOSITOR_HEIGHT=1080
COMPOSITOR_FPS=30
```

For CPU-only:

```dotenv
COMPOSITOR_WIDTH=960
COMPOSITOR_HEIGHT=540
COMPOSITOR_FPS=20
```

The CPU safe-mode clamp can reduce these requested values further.

## Chromium screencast JPEG quality

```dotenv
COMPOSITOR_JPEG_QUALITY=70
```

This is an intermediate Docker Chromium-to-FFmpeg transport quality, not the final stream bitrate/quality.

Lowering it can reduce compositor CPU/data movement at the cost of the intermediate image quality.

CPU-limited example:

```dotenv
COMPOSITOR_JPEG_QUALITY=55
```

---

# 17. Compositor output encoding

Advanced settings:

```dotenv
COMPOSITOR_AUDIO_BITRATE=128k
COMPOSITOR_VIDEO_BITRATE=6000k
COMPOSITOR_VIDEO_MAXRATE=6000k
COMPOSITOR_VIDEO_BUFSIZE=12000k
COMPOSITOR_X264_PRESET=veryfast
```

CPU-only low-load example:

```dotenv
COMPOSITOR_VIDEO_BITRATE=3000k
COMPOSITOR_VIDEO_MAXRATE=3200k
COMPOSITOR_VIDEO_BUFSIZE=6000k
COMPOSITOR_X264_PRESET=ultrafast
```

Again, reducing the canvas size/FPS is generally more effective at reducing browser/rendering load than changing bitrate alone.

---

# 18. Compositor debugging/transport

Normally leave these unset/false:

```dotenv
COMPOSITOR_DEBUG=false
COMPOSITOR_AUDIO_FIFO=false
```

`COMPOSITOR_AUDIO_FIFO=true` forces the older Linux named-pipe audio transport and is intended for diagnosis/compatibility rather than normal installations.

---

# 19. Music 24/7 worker timing

Defaults:

```dotenv
MUSIC24_POLL_MS=2000
MUSIC24_NOW_POLL_MS=750
MUSIC24_START_TIMEOUT_MS=60000
MUSIC24_EMBED_START_DELAY_MS=500
```

These control internal polling/startup timing.

Most users should not change them.

If the machine is very slow, increasing timeouts may avoid premature startup failures, but it does not make an overloaded renderer realtime.

---

# 20. Music 24/7 requested output size

```dotenv
MUSIC24_WIDTH=1920
MUSIC24_HEIGHT=1080
MUSIC24_FPS=30
```

On CPU-only hosts, safe mode can clamp these requested values.

For a low-power server you may explicitly request:

```dotenv
MUSIC24_WIDTH=960
MUSIC24_HEIGHT=540
MUSIC24_FPS=20
```

Or:

```dotenv
MUSIC24_WIDTH=640
MUSIC24_HEIGHT=360
MUSIC24_FPS=10
```

for a particularly constrained host.

---

# 21. VOD/rerun upload limit

```dotenv
VOD_MAX_GB=20
```

This is the maximum size of one uploaded rerun asset. It is **not** a total disk-space quota for all CastNexus data.

If you allow large uploads, make sure the disk has enough room for the original file plus temporary processing/recording usage.

---

# 22. VOD encoding

Defaults:

```dotenv
VOD_X264_PRESET=veryfast
VOD_VIDEO_BITRATE=6000k
VOD_VIDEO_MAXRATE=6500k
VOD_VIDEO_BUFSIZE=12000k
VOD_AUDIO_BITRATE=160k
VOD_FPS=30
```

If a VOD can be copied/remuxed safely CastNexus may avoid unnecessary processing, but normalization work can require encoding.

On a CPU-limited host, avoid running heavy VOD conversion during an important live broadcast.

---

# 23. Cover-art lookup

Default providers:

```dotenv
COVER_LOOKUP_PROVIDERS=musicbrainz,itunes
```

Timeout:

```dotenv
COVER_LOOKUP_TIMEOUT_MS=5000
```

Cache lifetime:

```dotenv
COVER_LOOKUP_CACHE_HOURS=168
```

Remote artwork size guard:

```dotenv
COVER_REMOTE_MAX_MB=10
```

MusicBrainz user agent:

```dotenv
COVER_MUSICBRAINZ_USER_AGENT=CastNexus/1.0 (https://github.com/NekoSuneProjects/CastNexus)
```

Apple/iTunes country:

```dotenv
COVER_ITUNES_COUNTRY=US
```

For a UK-oriented installation, for example:

```dotenv
COVER_ITUNES_COUNTRY=GB
```

---

# 24. YouTube upload integration

YouTube sign-in goes through the oauth-broker service, the same as Twitch - there are no local Google client credentials to configure on the dashboard. See section 5 to self-host your own broker with your own Google OAuth application instead.

Optional account allowlist:

```dotenv
YOUTUBE_UPLOAD_ALLOWLIST=
```

Examples:

```dotenv
YOUTUBE_UPLOAD_ALLOWLIST=mytwitchlogin
```

or explicitly every authenticated CastNexus account:

```dotenv
YOUTUBE_UPLOAD_ALLOWLIST=*
```

Local soft daily upload guard:

```dotenv
YOUTUBE_UPLOAD_DAILY_SOFT_LIMIT=90
```

This is a CastNexus-side guard and not Google's live quota counter.

---

# 25. LAN console interception

Leave these blank for normal OBS/PC/Music installs:

```dotenv
TARGET_IPS=
GATEWAY_IP=
INTERCEPT_MODE=lan
```

For console mode:

```dotenv
TARGET_IPS=192.168.1.100
GATEWAY_IP=192.168.1.1
INTERCEPT_MODE=lan
```

Multiple console addresses may be comma separated where supported:

```dotenv
TARGET_IPS=192.168.1.100,192.168.1.101
```

Start:

```bash
docker compose --profile console up -d
```

Do not enable interception for devices/networks you do not control.

---

# 26. DNS settings

Normal console helper settings:

```dotenv
DNS_UPSTREAM=1.1.1.1
DNS_LOG_ALL=true
```

Advanced internal/public-mode fields:

```dotenv
DNS_PUBLIC_MODE=false
DNS_REDIRECT_IP=
DNS_REDIRECT_IPV6=
DNS_ALLOWED_CLIENTS=
DNS_ALLOW_ANY=false
```

`DNS_ALLOW_ANY=true` should not be used casually on an internet-facing VPS because it can create an exposed DNS service.

---

# 27. VPS/public console gateway

Read [`VPS-CONSOLE-GATEWAY.md`](VPS-CONSOLE-GATEWAY.md) before using these.

```dotenv
PUBLIC_IP=
PUBLIC_IPV6=
VPS_ALLOWED_CLIENTS=
VPS_ALLOW_ANY=false
VPS_RTMP_PORT=1935
VPS_RTMP_WAIT_SECONDS=60
```

`VPS_ALLOWED_CLIENTS` should contain the allowed **home public/WAN source address**, not the console's private `192.168.x.x` address.

Do not set:

```dotenv
VPS_ALLOW_ANY=true
```

unless you deliberately understand the public DNS/RTMP exposure and have another security layer.

VPS mode is plain RTMP gateway behavior; DNS redirection cannot safely impersonate provider RTMPS/TLS certificates.

---

# 28. VRChat relay debug settings

Advanced relay settings available to the sidecar include:

```dotenv
VRCHAT_RELAY_POLL_MS=1500
VRCHAT_RELAY_DEBUG=false
```

Enable debug only while diagnosing relay behavior:

```dotenv
VRCHAT_RELAY_DEBUG=true
```

Then:

```bash
docker compose up -d --force-recreate
docker compose logs -f vrchat-relay
```

---

# 29. Example: normal home server

```dotenv
CASTNEXUS_IMAGE_TAG=latest
CASTNEXUS_CHANNEL=stable
CASTNEXUS_OAUTH_BROKER_URL=https://castnexus.nekosunevr.co.uk/oauth

PI_IP=192.168.1.50
DASHBOARD_PORT=8090
TARGET_IPS=
GATEWAY_IP=

CASTNEXUS_VIDEO_ENCODER=auto
CASTNEXUS_CPU_SAFE_MODE=auto

DESTINATION_AUDIO_BITRATE=128k
DESTINATION_AUDIO_RATE=44100
```

This is enough for most installations.

---

# 30. Example: low-power CPU-only server

```dotenv
PI_IP=192.168.1.50
DASHBOARD_PORT=8090

CASTNEXUS_VIDEO_ENCODER=cpu
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=640
CASTNEXUS_CPU_SAFE_HEIGHT=360
CASTNEXUS_CPU_SAFE_FPS=10
CASTNEXUS_CPU_JPEG_QUALITY=50

X264_PRESET=ultrafast
DESTINATION_FPS=20
DESTINATION_X264_PRESET=ultrafast

COMPOSITOR_GPU=false
COMPOSITOR_WIDTH=640
COMPOSITOR_HEIGHT=360
COMPOSITOR_FPS=10
COMPOSITOR_JPEG_QUALITY=50
COMPOSITOR_X264_PRESET=ultrafast

MUSIC24_WIDTH=640
MUSIC24_HEIGHT=360
MUSIC24_FPS=10
```

Keep most destinations on **Source** layout.

---

# 31. Example: stronger CPU-only server

```dotenv
CASTNEXUS_VIDEO_ENCODER=cpu
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=960
CASTNEXUS_CPU_SAFE_HEIGHT=540
CASTNEXUS_CPU_SAFE_FPS=20
CASTNEXUS_CPU_JPEG_QUALITY=60

X264_PRESET=ultrafast
DESTINATION_FPS=20

COMPOSITOR_GPU=false
COMPOSITOR_WIDTH=960
COMPOSITOR_HEIGHT=540
COMPOSITOR_FPS=20
COMPOSITOR_JPEG_QUALITY=60
```

Measure before increasing to 720p/1080p.

---

# 32. Example: NVIDIA server

`.env`:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
CASTNEXUS_CPU_SAFE_MODE=auto
COMPOSITOR_GPU=auto
COMPOSITOR_WIDTH=1920
COMPOSITOR_HEIGHT=1080
COMPOSITOR_FPS=30
NVENC_PRESET=p4
```

Start with GPU override:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-nvidia.yml \
  up -d
```

Verify:

```bash
nvidia-smi
docker compose logs --tail=250 dashboard
```

---

# 33. Example: Intel/AMD Linux graphics

`.env`:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
VAAPI_DEVICE=/dev/dri/renderD128
CASTNEXUS_CPU_SAFE_MODE=auto
COMPOSITOR_GPU=auto
```

Start:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-vaapi.yml \
  up -d
```

Verify host device:

```bash
ls -l /dev/dri
```

Check CastNexus logs for the selected hardware encoder.

---

# 34. Example: CPU-only VPS safe profile

```dotenv
CASTNEXUS_VIDEO_ENCODER=cpu
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=960
CASTNEXUS_CPU_SAFE_HEIGHT=540
CASTNEXUS_CPU_SAFE_FPS=20
CASTNEXUS_CPU_JPEG_QUALITY=55

COMPOSITOR_WIDTH=960
COMPOSITOR_HEIGHT=540
COMPOSITOR_FPS=20
COMPOSITOR_JPEG_QUALITY=55
COMPOSITOR_VIDEO_BITRATE=2500k
COMPOSITOR_VIDEO_MAXRATE=3000k
COMPOSITOR_VIDEO_BUFSIZE=5000k
COMPOSITOR_X264_PRESET=ultrafast

DESTINATION_VIDEO_BITRATE=3000k
DESTINATION_VIDEO_MAXRATE=3200k
DESTINATION_VIDEO_BUFSIZE=6000k
DESTINATION_X264_PRESET=ultrafast
RTMP_INPUT_QUEUE=2048
```

This is similar in spirit to the conservative VPS Compose overlay.

---

# 35. Check whether a setting reached the container

Example:

```bash
docker compose exec dashboard env | sort
```

Specific variable:

```bash
docker compose exec dashboard printenv CASTNEXUS_VIDEO_ENCODER
```

```bash
docker compose exec dashboard printenv CASTNEXUS_CPU_SAFE_WIDTH
```

```bash
docker compose exec dashboard printenv COMPOSITOR_FPS
```

This is useful if you edited `.env` but CastNexus appears to ignore the change.

---

# 36. Check the actual resource effect

Before changing settings:

```bash
docker stats
```

Then run the real workload and watch:

- CPU percentage
- memory usage
- network I/O
- block I/O

Also use:

```bash
htop
```

A tuning change is only an improvement if the stream remains realtime and stable.

---

# 37. Settings that should normally stay automatic

For most users, keep these defaults:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
CASTNEXUS_CPU_SAFE_MODE=auto
COMPOSITOR_GPU=auto
```

The automatic path is designed to probe real hardware and protect CPU-only hosts.

---

# 38. Security reminders

Never publish your real `.env` publicly without checking it.

Potential secrets/private information include:

- Twitch client secret
- YouTube client secret
- private/public host addresses
- allowlists
- account identifiers
- stream keys stored elsewhere in CastNexus state

The repository's `.env.example` is intended to be safe to share because it contains placeholders/defaults rather than your actual credentials.

---

## Related documentation

- Beginner setup: [`BEGINNER-SETUP.md`](BEGINNER-SETUP.md)
- Hardware / Docker / CPU / GPU sizing: [`HARDWARE-ENCODING.md`](HARDWARE-ENCODING.md)
- GPU/VOD/YouTube internals: [`GPU-TWITCH-RECORDINGS-YOUTUBE.md`](GPU-TWITCH-RECORDINGS-YOUTUBE.md)
- Hosted OAuth: [`HOSTED-OAUTH.md`](HOSTED-OAUTH.md)
- VPS console gateway: [`VPS-CONSOLE-GATEWAY.md`](VPS-CONSOLE-GATEWAY.md)
