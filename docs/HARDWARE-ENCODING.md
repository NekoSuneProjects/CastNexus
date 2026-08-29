# CastNexus Hardware, Docker and Encoding Guide

This guide explains **what the CastNexus Docker containers actually do**, how much CPU/GPU/RAM/storage/network capacity to plan for, and how CastNexus behaves on CPU-only and GPU-backed servers.

It is written for both beginners trying to choose hardware and advanced users sizing a VPS/home server.

> [!IMPORTANT]
> There is no single exact CPU requirement for video processing. A modern 6-core desktop CPU can be much faster than six shared VPS vCPUs, and the workload changes dramatically depending on whether CastNexus is **copying an existing H.264 stream** or **rendering/re-encoding video**. Use the sizing tables below as conservative starting points, then verify the actual host with `docker stats` while your real profiles are live.

---

# 1. What Docker is doing in CastNexus

Docker does not emulate another computer. It runs isolated application processes called **containers** using the Linux host kernel.

Useful Docker terms:

| Term | What it means in CastNexus |
|---|---|
| **Image** | Packaged application filesystem downloaded from GHCR/Docker Hub. |
| **Container** | A running instance of an image. |
| **Docker Compose** | Reads `docker-compose.yml` and starts the CastNexus services together. |
| **Compose profile** | Optional group of services, such as the `console` DNS/interception helpers. |
| **Bind mount** | A real host folder mounted into a container so data survives container replacement. |
| **Host networking** | The container uses the host network directly instead of Docker NAT. CastNexus uses this for its streaming listeners. |
| **Environment variable** | A setting supplied from `.env`, such as the dashboard port or encoder choice. |

The normal command:

```bash
docker compose up -d
```

means:

1. read `docker-compose.yml`
2. read values from `.env`
3. create any missing containers
4. recreate containers whose configuration changed
5. start them
6. keep them running in the background because of `-d`

It does **not** automatically pull a newer Git repository or necessarily fetch a newer image first. For updates use:

```bash
git pull
docker compose pull
docker compose up -d
```

---

# 2. Normal CastNexus containers

A basic CastNexus install runs these main services.

## `castnexus-dashboard`

This is the largest application container.

It contains the CastNexus Studio backend plus the tools used for media processing, including:

- the web dashboard/API
- FFmpeg/FFprobe
- Chromium for server-side rendered scenes
- yt-dlp
- Deno
- Music 24/7 worker
- destination output workers
- VOD/rerun processing
- overlay compositor
- hardware encoder detection

This is normally the container that consumes the most CPU and RAM when CastNexus is doing real video work.

Check it with:

```bash
docker compose stats dashboard
```

Or all containers:

```bash
docker stats
```

## `castnexus-mediamtx`

MediaMTX is the main media router.

It receives/publishes protocols including:

- RTMP
- RTSP
- HLS
- WebRTC/WHEP
- SRT

It also provides the local control/playback APIs CastNexus uses for recording management.

MediaMTX is usually much lighter than a full video encoder because routing/remuxing a stream does not necessarily require decoding and encoding every frame.

## `castnexus-mediamtx-vrchat`

This is a second MediaMTX instance dedicated to the VRChat/Unity/AVPro-friendly MPEG-TS HLS output on port `8898`.

It is separate so the primary low-latency HLS/WebRTC configuration can remain unchanged.

## `castnexus-vrchat-relay`

This sidecar creates the VRChat-compatible media path. It selects the compatible H.264/AAC stream and republishes it to the second MediaMTX instance.

It normally remuxes/copies compatible media rather than doing another full video encode.

---

# 3. Optional console containers

These only run when the appropriate Compose profile is enabled.

```bash
docker compose --profile console up -d
```

## `castnexus-dns`

The DNS service answers selected console/Twitch ingest DNS requests so an authorized console broadcast can be directed through the CastNexus host.

It needs port `53` when console mode is active.

## `castnexus-intercept`

The interception service performs the network-side routing required by LAN console capture.

It has the Linux capabilities:

```text
NET_ADMIN
NET_RAW
```

These are intentionally **not** needed for normal PC/OBS/Music installs.

Only enable console mode on a network you own/control.

---

# 4. Persistent data versus disposable containers

Containers should be treated as replaceable.

The important CastNexus data is bind-mounted from the host, for example:

```text
./dashboard/data
```

That directory contains persistent application data such as state, music, VODs and recordings.

Therefore these commands are normally safe for the data directory:

```bash
docker compose down
docker compose pull
docker compose up -d
```

Do **not** manually delete `dashboard/data` unless you intend to remove CastNexus application data.

Before a major upgrade, making a backup is still recommended:

```bash
cp -a dashboard/data "dashboard/data-backup-$(date +%Y%m%d-%H%M%S)"
```

---

# 5. The most important performance rule: copy versus encode

The CPU requirement changes massively depending on the destination layout.

## Source / passthrough layout

For a destination using the **Source** layout, CastNexus normally uses:

```text
video: copy
audio: AAC normalize/transcode
```

That means CastNexus does not decode and re-encode every H.264 video frame just to send the same picture to another RTMP destination.

This is the cheapest way to run CastNexus.

A small server can often route several source-layout outputs because the expensive video encode is avoided.

## Landscape or Vertical layout

When CastNexus needs to:

- force a 16:9 canvas
- force a 9:16 canvas
- scale/pad video
- create the blurred background layout
- render an overlay/compositor scene
- render Music 24/7
- normalize some VOD content

it must process frames and normally perform a new H.264 encode.

That is where CPU or hardware GPU encoding matters.

---

# 6. How to estimate the number of expensive encodes

Do not estimate load only by the number of containers. Estimate **simultaneous video jobs**.

A useful mental model is:

```text
full encode jobs ~= transformed destinations
                 + active browser compositor outputs
                 + Music 24/7 render when active
                 + VOD normalization/transcode jobs when active
```

A destination using `Source` layout normally does **not** count as a full video encode because video is copied.

Examples:

### Example A — simple restream

- OBS -> CastNexus
- Twitch destination = Source
- YouTube destination = Source

Approximate full video encodes performed by CastNexus:

```text
0
```

The host still performs audio normalization, routing, application work and networking, but this is much cheaper than two x264 encodes.

### Example B — one horizontal and one vertical destination

- Twitch = Source
- YouTube = 16:9 Landscape
- TikTok/custom = 9:16 Vertical

Approximate full CastNexus video encodes:

```text
2
```

### Example C — Music 24/7

Music 24/7 requires Chromium/scene rendering plus an H.264 output.

Approximate heavy jobs:

```text
1 browser render + 1 video encode
```

If that generated stream is then transformed differently for additional destinations, each transformed destination can add another encode.

---

# 7. CPU-only encoding

CastNexus supports a CPU-only server.

When no working hardware encoder is available, the encoder falls back to:

```text
libx264
```

Force CPU mode with:

```dotenv
CASTNEXUS_VIDEO_ENCODER=cpu
```

Other accepted software-style values include `x264`, `libx264` and `software`.

## CPU safe mode

CastNexus has an automatic CPU protection mode.

When no working hardware encoder is detected, `auto` safe mode limits expensive generated/transformed video rather than assuming every CPU-only server can render 1920x1080 at 30 FPS.

Default CPU-safe target:

```dotenv
CASTNEXUS_CPU_SAFE_MODE=auto
CASTNEXUS_CPU_SAFE_WIDTH=960
CASTNEXUS_CPU_SAFE_HEIGHT=540
CASTNEXUS_CPU_SAFE_FPS=20
CASTNEXUS_CPU_JPEG_QUALITY=60
```

On CPU-only output it also prefers an x264 preset designed to reduce CPU pressure.

For an overloaded host, an extra-safe profile is:

```dotenv
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=640
CASTNEXUS_CPU_SAFE_HEIGHT=360
CASTNEXUS_CPU_SAFE_FPS=10
CASTNEXUS_CPU_JPEG_QUALITY=50
X264_PRESET=ultrafast
```

The older `CASTNEXUS_PI_SAFE_*` variables remain supported aliases, but new installations should prefer the `CASTNEXUS_CPU_SAFE_*` names.

---

# 8. x264 preset versus CPU usage

For CPU encoding, the preset changes the amount of work x264 does.

Very roughly:

```text
ultrafast -> least CPU, worse compression efficiency
superfast
veryfast  -> more CPU, better compression efficiency
faster
fast      -> significantly more CPU
...
```

For a live CPU-only CastNexus server, do not choose a slow preset just because it sounds higher quality. If the encoder cannot stay realtime, the result is worse: frames queue, latency grows and the stream can fail.

Recommended CPU-only starting point:

```dotenv
X264_PRESET=ultrafast
```

or leave CastNexus safe-mode selection on automatic.

If the host has plenty of spare CPU, test:

```dotenv
X264_PRESET=veryfast
```

while watching:

```bash
docker stats
```

---

# 9. Why six cores can still reach 95-100%

A "6-core server" does not automatically mean six full modern desktop cores are available to CastNexus.

Common reasons a six-core/vCPU machine becomes saturated:

- other Docker containers are already using CPU
- VPS vCPUs are shared with other customers
- old CPU architecture / low single-core speed
- one or more x264 encodes are active
- Chromium is rendering an animated scene
- 1080p30 was forced on a CPU-only server
- multiple transformed destination layouts are enabled
- VOD processing is happening at the same time
- another application is transcoding video
- the host is thermal throttling
- CPU steal time is high on a VPS

If CastNexus was sharing six cores with other services and the total host was already around 95%, that should be treated as **not enough headroom**, even if CastNexus itself was not responsible for all 95%.

For a streaming server, try to leave sustained headroom instead of planning around 100% CPU.

A practical target is to keep normal sustained load below roughly **70-80%** so reconnects, scene changes and short encode spikes do not immediately overload the host.

---

# 10. Conservative hardware sizing

These are planning guidelines, not guaranteed benchmarks.

## Tier A — routing / Source-layout restream only

Typical workload:

- one OBS/console input
- one to several Source-layout destinations
- no generated Music 24/7 scene
- no heavy overlay compositor
- minimal VOD processing

Minimum starting point:

```text
CPU:     2 modern x86-64 cores / vCPUs
RAM:     4 GB
Storage: 10 GB free + space for user media
```

Recommended:

```text
CPU:     4 cores
RAM:     8 GB
Storage: 25+ GB free
```

Why this can work: compatible destination video is copied instead of software-encoded.

## Tier B — CPU-only generated/transformed video

Typical workload:

- one Music 24/7/compositor stream, or
- one transformed 16:9/9:16 output
- CPU safe mode enabled

Minimum practical starting point:

```text
CPU:     4 fast modern cores dedicated mostly to CastNexus
RAM:     8 GB
Mode:    CPU safe mode
```

Recommended when the machine runs other services too:

```text
CPU:     6-8 modern cores
RAM:     8-16 GB
```

For a shared VPS, choose more vCPUs than the equivalent dedicated physical-core machine because performance can vary.

## Tier C — CPU-only 720p30 production

For a reliable generated/transformed 720p30 workload, start around:

```text
CPU:     6-8 modern dedicated cores
RAM:     8-16 GB
Preset:  ultrafast/veryfast depending on measured headroom
```

One additional simultaneous transformed output can materially increase CPU usage.

## Tier D — CPU-only 1080p30 compositor / multiple transforms

This is **not the recommended design**.

A sensible planning point is:

```text
CPU:     12+ fast modern cores
RAM:     16 GB+
```

Even then it depends heavily on scene complexity, CPU generation and number of simultaneous output jobs.

If you need reliable 1080p30 generated scenes or multiple transformed outputs, use a supported hardware encoder instead of buying CPU purely to do live H.264 in software.

## Tier E — GPU-accelerated server

For one or a few 1080p outputs with a supported hardware encoder:

Minimum practical host:

```text
CPU:     4 modern cores
RAM:     8 GB
GPU/iGPU: working supported H.264 hardware encoder
```

Recommended for Music 24/7, overlays and several destinations:

```text
CPU:     6-8 modern cores
RAM:     16 GB
GPU/iGPU: supported hardware encoder with current driver/runtime
```

The CPU is still important because Chromium rendering, filters, audio, networking and the dashboard do not disappear when hardware encoding is enabled.

---

# 11. GPU memory is not the main requirement

For CastNexus H.264 live encoding, the most important GPU feature is **a supported hardware video encoder and working driver/runtime**, not a huge amount of VRAM.

A card with lots of VRAM but no compatible H.264 encoder can still fall back to CPU.

Likewise, an older card may expose `h264_nvenc` in FFmpeg but fail the real encode probe because of driver/API compatibility.

CastNexus therefore does a real one-frame encoder test before selecting hardware.

Keep:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
```

unless you are troubleshooting or deliberately forcing an encoder.

---

# 12. Supported encoder choices

Current CastNexus H.264 encoder profiles include:

| Setting | Encoder | Typical platform |
|---|---|---|
| `auto` | automatic real probe | recommended |
| `cpu` / `libx264` | x264 software | any FFmpeg host |
| `nvenc` | `h264_nvenc` | NVIDIA |
| `qsv` | `h264_qsv` | Intel Quick Sync |
| `vaapi` | `h264_vaapi` | Linux Intel/AMD graphics |
| `amf` | `h264_amf` | AMD Windows/compatible FFmpeg |
| `videotoolbox` | `h264_videotoolbox` | macOS |
| `v4l2m2m` | `h264_v4l2m2m` | supported Linux SoCs |

If a requested hardware encoder is unavailable or its probe fails, CastNexus falls back to CPU x264 rather than pretending the GPU is working.

---

# 13. NVIDIA Docker encoding

On Linux, the NVIDIA driver must work on the **host first**.

Check:

```bash
nvidia-smi
```

If that fails, fix the host driver before troubleshooting CastNexus.

Then install/configure NVIDIA Container Toolkit using NVIDIA's current instructions:

<https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html>

The important Docker runtime configuration step is currently:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify that Docker can see the GPU before starting CastNexus.

Then use the included override:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-nvidia.yml \
  up -d
```

That override grants the dashboard container GPU access with:

```yaml
gpus: all
```

Keep encoder selection automatic:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
```

Or force NVENC while testing:

```dotenv
CASTNEXUS_VIDEO_ENCODER=nvenc
```

Check the dashboard log for encoder selection/fallback information:

```bash
docker compose logs --tail=200 dashboard
```

## NVIDIA tuning

Optional advanced preset:

```dotenv
NVENC_PRESET=p4
```

Do not randomly increase quality/preset complexity until the normal stream is stable.

---

# 14. Intel and AMD GPU encoding on Linux

Linux Intel/AMD acceleration normally needs a working `/dev/dri` device.

Check:

```bash
ls -l /dev/dri
```

Typical render device:

```text
/dev/dri/renderD128
```

Use the included Compose override:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-vaapi.yml \
  up -d
```

It maps `/dev/dri` into the dashboard container.

Keep:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
VAAPI_DEVICE=/dev/dri/renderD128
```

CastNexus can probe Intel Quick Sync and VAAPI and uses the first hardware path that genuinely works.

To test explicitly:

```dotenv
CASTNEXUS_VIDEO_ENCODER=qsv
```

or:

```dotenv
CASTNEXUS_VIDEO_ENCODER=vaapi
```

If the explicit probe fails, CastNexus falls back to x264 and records the reason in encoder status/logging.

---

# 15. Raspberry Pi / ARM

A Raspberry Pi is excellent for lightweight routing and control, but software video rendering is much more demanding than simply forwarding packets.

Recommended Pi:

```text
Raspberry Pi 5
64-bit Raspberry Pi OS
8 GB RAM preferred
active cooling strongly recommended
SSD preferred for recordings/VODs
```

For CPU-rendered Music 24/7 or transformed output, keep safe mode enabled.

Normal Pi-safe starting point:

```dotenv
CASTNEXUS_CPU_SAFE_MODE=auto
CASTNEXUS_CPU_SAFE_WIDTH=960
CASTNEXUS_CPU_SAFE_HEIGHT=540
CASTNEXUS_CPU_SAFE_FPS=20
CASTNEXUS_CPU_JPEG_QUALITY=60
```

For a heavy animated scene:

```dotenv
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=640
CASTNEXUS_CPU_SAFE_HEIGHT=360
CASTNEXUS_CPU_SAFE_FPS=10
CASTNEXUS_CPU_JPEG_QUALITY=50
X264_PRESET=ultrafast
```

Do not expect a Pi CPU to behave like a desktop GPU encoder at 1080p30.

Check temperature:

```bash
vcgencmd measure_temp
```

Check throttling:

```bash
vcgencmd get_throttled
```

A result of:

```text
throttled=0x0
```

means no current/historical throttle flags are set.

---

# 16. VPS sizing warning

`vCPU` is not a universal performance measurement.

A provider can give six vCPUs that are:

- shared
- frequency-limited
- older-generation cores
- affected by noisy neighbours
- exposed with significant steal time

Check CPU steal time with:

```bash
top
```

Look for `%st`/steal on virtualized Linux hosts.

For CPU-only video generation on a VPS, prefer a provider with dedicated CPU cores or use a GPU-enabled server.

The `docker-compose.vps.yml` overlay deliberately uses conservative compositor defaults for CPU-only VPS hosts.

---

# 17. RAM requirements

RAM is usually not the first bottleneck during H.264 encoding, but Chromium scenes, Node.js, FFmpeg queues and multiple workers add up.

Planning guide:

| Workload | RAM |
|---|---:|
| Minimal routing/test install | 4 GB minimum |
| Normal home server | 8 GB recommended |
| Music/overlays + several services | 16 GB comfortable |
| Heavy VOD/media server shared with other apps | 16-32 GB depending on other workloads |

Avoid running the host so close to the RAM limit that it constantly swaps while streaming.

Check:

```bash
free -h
```

And:

```bash
docker stats
```

---

# 18. Storage requirements

The application images are only part of the storage requirement.

Plan storage for:

- Docker images/layers
- uploaded music
- uploaded rerun videos
- MediaMTX recordings
- temporary processing files
- logs

Basic install:

```text
10 GB free: absolute small-test starting point
25 GB free: more sensible normal minimum
50-100+ GB: recommended when recordings/VOD uploads are used
```

CastNexus recordings are not automatically deleted by default, so recordings can eventually consume all available disk space if nobody manages them.

Check host disk usage:

```bash
df -h
```

Check CastNexus data:

```bash
du -sh dashboard/data
```

Inspect Docker usage:

```bash
docker system df
```

> [!CAUTION]
> Do not blindly run aggressive Docker prune commands on a server you do not understand. Docker may contain unrelated images/containers/volumes used by other applications.

---

# 19. Network bandwidth sizing

Each destination needs its own outgoing stream bandwidth even when video is being copied.

A simple estimate is:

```text
required upload ~= (video bitrate + audio bitrate) x number of internet destinations
```

Then add at least 20-30% headroom for protocol overhead and normal variation.

Example using approximately:

```text
video = 6.0 Mbps
audio = 0.128 Mbps
```

One destination:

```text
~6.13 Mbps
```

Three destinations:

```text
~18.4 Mbps
```

With 30% headroom:

```text
~24 Mbps upload recommended
```

If CastNexus is on a remote VPS and OBS sends a 6 Mbps input to it, the VPS also receives that inbound traffic in addition to sending the destination streams.

Public HLS/WebRTC viewers create additional server bandwidth usage as well.

For reliable live streaming, wired Ethernet is strongly preferred for the CastNexus server.

---

# 20. Detect what encoder CastNexus selected

Keep:

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
```

Then start/recreate the stack and inspect the dashboard logs:

```bash
docker compose up -d --force-recreate
docker compose logs --tail=250 dashboard
```

The Studio also exposes encoder information in relevant runtime/status areas.

If a hardware encoder fails, look for a fallback reason before assuming CastNexus is actually using the GPU.

---

# 21. Force CPU for diagnosis

Sometimes the easiest test is to deliberately remove GPU uncertainty.

Set:

```dotenv
CASTNEXUS_VIDEO_ENCODER=cpu
CASTNEXUS_CPU_SAFE_MODE=true
X264_PRESET=ultrafast
```

Apply:

```bash
docker compose up -d --force-recreate
```

If the stream works in CPU mode but fails in hardware mode, investigate the GPU driver/runtime/device mapping.

---

# 22. Force hardware for diagnosis

Examples:

NVIDIA:

```dotenv
CASTNEXUS_VIDEO_ENCODER=nvenc
```

Intel Quick Sync:

```dotenv
CASTNEXUS_VIDEO_ENCODER=qsv
```

Linux VAAPI:

```dotenv
CASTNEXUS_VIDEO_ENCODER=vaapi
VAAPI_DEVICE=/dev/dri/renderD128
```

Then recreate and inspect logs:

```bash
docker compose up -d --force-recreate
docker compose logs --tail=250 dashboard
```

After troubleshooting, `auto` is normally the better production setting.

---

# 23. Find out whether CastNexus or another service is using the CPU

Start with host process usage:

```bash
htop
```

If `htop` is not installed:

```bash
sudo apt install -y htop
```

Then compare Docker containers:

```bash
docker stats
```

Single-container view:

```bash
docker stats castnexus-dashboard castnexus-mediamtx castnexus-mediamtx-vrchat castnexus-vrchat-relay
```

Check process names inside the dashboard container:

```bash
docker compose exec dashboard ps aux
```

Common heavy processes during active processing can include:

```text
ffmpeg
chromium/chrome
node
```

If the **whole machine** is 95% but `castnexus-dashboard` is only using a small fraction, the problem is other host workloads, not CastNexus alone.

---

# 24. CPU overload symptoms

Common symptoms include:

- output FPS lower than requested
- increasing stream latency
- repeated compositor watchdog/reconnect messages
- FFmpeg falls behind realtime
- Music 24/7 scene freezes/stutters
- dashboard becomes slow while streaming
- system load average stays above available cores
- CPU reaches 90-100% for long periods

Check:

```bash
uptime
```

On a 6-core system, a sustained load average far above approximately `6` means runnable work is consistently queuing. Load average is not identical to CPU percentage, but it is a useful warning sign.

---

# 25. Reduce CPU use in the safest order

If a CPU-only host is overloaded, try these in order.

### 1. Keep destination layouts on Source where possible

This avoids unnecessary video re-encoding.

### 2. Enable/lower CPU safe mode

```dotenv
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=640
CASTNEXUS_CPU_SAFE_HEIGHT=360
CASTNEXUS_CPU_SAFE_FPS=10
```

### 3. Use x264 ultrafast

```dotenv
X264_PRESET=ultrafast
```

### 4. Reduce transformed output FPS

```dotenv
DESTINATION_FPS=20
```

### 5. Reduce compositor FPS/size

```dotenv
COMPOSITOR_WIDTH=960
COMPOSITOR_HEIGHT=540
COMPOSITOR_FPS=20
COMPOSITOR_JPEG_QUALITY=55
```

### 6. Reduce the number of simultaneous transformed destinations

Several Source-layout destinations are much cheaper than several independently scaled/vertical outputs.

### 7. Move unrelated workloads off the same host

Database servers, game servers, Plex/Jellyfin transcoding, compilation jobs and other containers can take away the realtime headroom CastNexus needs.

### 8. Add hardware encoding

For regular 1080p generated/transformed streaming, this is normally the best long-term solution.

---

# 26. Example CPU-only server profiles

## Low-power / shared CPU

```dotenv
CASTNEXUS_VIDEO_ENCODER=cpu
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=640
CASTNEXUS_CPU_SAFE_HEIGHT=360
CASTNEXUS_CPU_SAFE_FPS=10
CASTNEXUS_CPU_JPEG_QUALITY=50
X264_PRESET=ultrafast
DESTINATION_FPS=20
COMPOSITOR_WIDTH=640
COMPOSITOR_HEIGHT=360
COMPOSITOR_FPS=10
COMPOSITOR_JPEG_QUALITY=50
```

Use Source-layout destinations whenever possible.

## Mid-range CPU-only server

```dotenv
CASTNEXUS_VIDEO_ENCODER=cpu
CASTNEXUS_CPU_SAFE_MODE=true
CASTNEXUS_CPU_SAFE_WIDTH=960
CASTNEXUS_CPU_SAFE_HEIGHT=540
CASTNEXUS_CPU_SAFE_FPS=20
CASTNEXUS_CPU_JPEG_QUALITY=60
X264_PRESET=ultrafast
COMPOSITOR_WIDTH=960
COMPOSITOR_HEIGHT=540
COMPOSITOR_FPS=20
```

## Powerful CPU-only experimental 720p

```dotenv
CASTNEXUS_VIDEO_ENCODER=cpu
CASTNEXUS_CPU_SAFE_MODE=false
X264_PRESET=veryfast
COMPOSITOR_WIDTH=1280
COMPOSITOR_HEIGHT=720
COMPOSITOR_FPS=30
DESTINATION_FPS=30
```

Only use this after measuring the actual machine under full live workload.

---

# 27. Example GPU server profile

```dotenv
CASTNEXUS_VIDEO_ENCODER=auto
CASTNEXUS_CPU_SAFE_MODE=auto
COMPOSITOR_GPU=auto
COMPOSITOR_WIDTH=1920
COMPOSITOR_HEIGHT=1080
COMPOSITOR_FPS=30
DESTINATION_FPS=30
```

NVIDIA host startup:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-nvidia.yml \
  up -d
```

Intel/AMD Linux host startup:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-vaapi.yml \
  up -d
```

Always confirm the selected encoder after startup instead of assuming device passthrough means the encode probe succeeded.

---

# 28. Recommended monitoring commands

Keep these handy:

```bash
# Host CPU/RAM/processes
htop

# Per-container CPU/RAM/network/block I/O
docker stats

# CastNexus services
docker compose ps

# Dashboard/encoder/compositor logs
docker compose logs -f dashboard

# Media server logs
docker compose logs -f mediamtx

# Disk
df -h
du -sh dashboard/data

# System load
uptime

# NVIDIA
nvidia-smi

# Intel/AMD render devices
ls -l /dev/dri
```

---

# 29. Recommended decision tree

```text
Do you only need Source-layout restreaming?
|
+-- Yes -> CPU-only is usually fine. Start with 4 cores / 8 GB.
|
+-- No -> Are you generating Music/overlays or resizing/vertical outputs?
          |
          +-- Yes -> Do you have a supported hardware encoder?
                    |
                    +-- Yes -> enable GPU/iGPU access and keep encoder=auto.
                    |
                    +-- No -> enable CPU safe mode, use ultrafast,
                              and budget substantially more CPU.
```

For a new production build that will regularly do 1080p generated/transformed output, prefer a supported hardware encoder.

---

## Related documentation

- Beginner installation: [`BEGINNER-SETUP.md`](BEGINNER-SETUP.md)
- Advanced `.env` configuration: [`ADVANCED-CONFIGURATION.md`](ADVANCED-CONFIGURATION.md)
- Existing GPU/VOD/YouTube notes: [`GPU-TWITCH-RECORDINGS-YOUTUBE.md`](GPU-TWITCH-RECORDINGS-YOUTUBE.md)
- VPS console gateway: [`VPS-CONSOLE-GATEWAY.md`](VPS-CONSOLE-GATEWAY.md)
