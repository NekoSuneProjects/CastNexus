# Music 24/7 performance

This page explains why Music 24/7 used so much CPU, what changed, how to pick a
Performance Mode, and how to benchmark your own host.

## What was actually using the CPU

`tools/music24-benchmark.js` runs the real Music 24/7 scene and the real
compositor (Chromium screencast → FFmpeg) against a synthetic track, publishes
to a null sink and measures CPU per process class. The same run was made
before and after the changes, on the same machine.

Test host: Intel i7-6700K (4 cores / 8 threads), Windows 10, Chrome headless,
FFmpeg 8 (gyan.dev build). Chromium was forced to software rendering
(`COMPOSITOR_GPU=false`, SwiftShader) to match a typical VPS. CPU is shown as a
percentage of **one** core, as `top` does (800% = the whole machine). A Linux
VPS gives different absolute numbers; compare before and after on your own host
with the benchmark tool.

| Scenario | Build | Total CPU | Chromium | FFmpeg encoder | Frames reaching the encoder |
|---|---|---|---|---|---|
| CPU x264, 1920×1080@30 | before | **512%** | 442% | 65% | 4.2 fps (1 027 dropped) |
| CPU x264, 1920×1080@30, **Low CPU** | after | **128%** | 68% | 59% | 21 fps |
| CPU x264, 1920×1080@30, **Ultra Low CPU** | after | **112%** | 54% | 57% | 12.8 fps (render rate; output stays 30) |
| CPU x264, 1920×1080@30, **Balanced** | after | 234% | 154% | 75% | 25.6 fps |
| CPU x264, 1920×1080@30, **Maximum** | after | 463% | 366% | 93% | 32 fps |
| CPU x264, default CPU-safe clamp (960×540@20) | before | **426%** | 410% | 11% | 2.5 fps |
| CPU x264, default CPU-safe clamp, **Auto** | after | **32%** | 22% | 9% | 21 fps |
| NVENC 1080p30, SwiftShader Chromium | before | **482%** | 462% | 15% | 4.9 fps |
| NVENC 1080p30, SwiftShader Chromium, **Auto** (Balanced) | after | **167%** | 141% | 22% | 25.6 fps |

RAM for the whole Music 24/7 tree dropped from about 0.9–1.5 GB to 0.8–1.0 GB.

### Root causes

1. **Chromium redrew the whole 1080p page 60 times a second.** The scene had
   infinite CSS animations: a masked full-screen grid drift, a spinning vinyl,
   a sliding progress gradient, a pulsing badge, a title pulse, glitch layers,
   plus full-screen `mix-blend-mode` scanlines, a `drop-shadow` filter on the
   spectrum canvas and `shadowBlur` on every bar. Any damaged pixel makes
   headless Chromium re-rasterise the page (in software on a VPS) and
   JPEG-encode the entire frame for the screencast, even when FFmpeg only
   needed 20–30 of them.
2. **The spectrum, the page clock and the metadata polling were all tied to
   the output rate.** The spectrum redrew at 30 Hz, the page polled `now.json`
   every second, and the worker polled it over loopback HTTP every 750 ms.
3. **FFmpeg 7+/8 starved the video input.** With wall-clock timestamps on the
   screencast frames next to a realtime PCM audio input, FFmpeg's threaded
   scheduler kept the video demuxer choked. Only 5–6 of 20 frames per second
   got through; the rest were dropped. That is why the "before" rows deliver
   2–5 fps. FFmpeg 5.1 (Debian bookworm, the Docker image) does not have that
   scheduler, but desktop installs with newer FFmpeg do.
4. **FFmpeg probed the MJPEG pipe for about 5 s on every (re)start** because
   the default probe settings were used.

### What changed

- **Performance Modes.** Render FPS, spectrum rate, progress rate and effects
  are now separate from the output FPS. FFmpeg repeats frames up to the output
  rate; repeated frames encode as near-free P-skips.
- **Reduced effects** turn off every continuous CSS animation and blend layer.
  The motion that matters (spectrum, vinyl, progress) runs from one JS timer at
  the spectrum rate. In Minimal mode an idle spectrum does not move, so
  Chromium produces no frames at all.
- **Layers are isolated.** The progress bar uses `transform` instead of
  `width`, the spectrum canvas is its own layer, gradients are cached, the
  per-frame analyser buffer is reused, and text is only re-measured when the
  track changes.
- **Event-driven metadata.** The music engine's advance events reach the page
  over SSE and reach the worker in-process. Polling is kept only as a slow
  fallback (15 s in the page, `MUSIC24_NOW_POLL_MS`=5 s in the worker).
- **Screencast frame skipping.** In full-effects mode the CDP `everyNthFrame`
  value stops Chromium JPEG-encoding frames above the capture rate.
- **Constant-rate frame pump** (`COMPOSITOR_PUMP_TIMESTAMPS=cfr`). The pump is
  locked to the wall clock and repeats the latest frame to repay frames it
  owes, so there is no A/V drift. `wallclock` is still available.
- **Bounded input probing** for the MJPEG and PCM inputs.
- **The encoder is chosen per Music profile** (Auto / NVENC / QuickSync /
  VAAPI / AMF / CPU x264). Each hardware choice is probed before use, and a
  runtime failure walks NVENC → QSV/VAAPI → x264 instead of stopping the
  broadcast.

## Automatic hardware test (Auto)

Before the first stream starts, CastNexus tests the machine it runs on. The
test takes about 6 seconds and runs once; the result is cached in
`data/host-profile.json` and re-run automatically when the CPU, GPU, encoder or
FFmpeg changes. You can also re-run it from **Settings → System performance →
Re-test hardware**.

| Check | How |
|---|---|
| Host type | Raspberry Pi / ARM board (device-tree), VPS (hypervisor flag / cloud DMI vendor), desktop PC |
| Video encoder | the existing real one-frame encode probe (NVENC → QSV → VAAPI/AMF → x264) |
| Browser GPU | launches headless Chromium with GPU flags and reads the WebGL renderer; SwiftShader/llvmpipe means "software" |
| CPU speed | `ffmpeg -benchmark` of a 1080p x264 encode (best of two runs) = milliseconds of CPU per frame |

Auto then estimates the cores each quality tier needs on *this* CPU and picks
the best one that fits a budget:

| Host type | CPU budget (of all cores) | Why |
|---|---|---|
| Raspberry Pi | 70% | dedicated box |
| VPS | 50% | shared host, leave room for destinations and relays |
| Desktop PC | 35% | the same PC usually also runs the game and OBS |

Override the budget with `CASTNEXUS_AUTO_CPU_BUDGET` (0–1), e.g. `0.25`.

Music 24/7 tiers go from 1080p30 Balanced down to 360p20 Ultra; overlay
program tiers go from 1080p60 down to 540p20. Program FPS is also capped at
the real frame rate of the incoming OBS/console stream (probed with `ffprobe`
before the program starts), so a 30 fps source is never rendered at 60.
Maximum Quality is never auto-selected: even with a real GPU, the full-effects
scene delivered under 1 unique frame per second through the Chromium
screencast while using about 3 cores.

**Live step-down.** While streaming, Auto checks the real browser render rate,
encoder intake and dropped frames every 10 s. After three bad checks in a row
(30 s), the tier is marked too heavy and Music 24/7 restarts one tier lower.
The step-down is remembered, and Re-test hardware clears it.

What it chose on the test machines:

| Host | Music 24/7 | Overlay program |
|---|---|---|
| Windows PC, i7-6700K + GTX 980 Ti (NVENC + GPU Chromium, measured) | 1080p30 Balanced | 1080p60 (capped to the source FPS) |
| 6-core CPU-only VPS (simulated, 1.6× slower cores) | 1080p30 Balanced | 720p30 |
| 2-core VPS (simulated) | 720p30 Low | 540p30 |
| Raspberry Pi 4 (simulated) | 720p30 Low | 540p20 |

To pin a fixed quality, pick a mode or resolution yourself in **Music / 24/7
→ Performance & encoder** (or a program size in **Overlay Studio → Program
output settings**), or set `CASTNEXUS_CPU_SAFE_MODE=true` to force the old
CPU-safe clamp.

## Choosing a mode

| Mode | Render FPS | Spectrum | Effects | Use when |
|---|---|---|---|---|
| Auto | Balanced with a hardware encoder, Low CPU without | | | Default |
| Maximum Quality | output FPS | 30 Hz | full (all animations) | GPU host with working Chromium GPU rasterisation |
| Balanced | 24 | 24 Hz | reduced | Hardware encoder, software Chromium |
| Low CPU | 20 | 12 Hz | reduced | CPU-only VPS |
| Ultra Low CPU | 12 | 10 Hz | minimal | Tiny / shared VPS |

Audio is never reduced. It is decoded by FFmpeg straight from the file and does
not pass through the browser.

In **Auto**, a CPU-only host keeps the existing CPU-safe resolution clamp
(`CASTNEXUS_CPU_SAFE_*`, 960×540@20 by default). Selecting any explicit mode
uses the resolution you choose in the dashboard.

All of this is set per profile under **Music / 24/7 → Performance & encoder**,
which also shows the live encoder, resolution, FPS, measured render rate and
CPU usage of each component.

## Benchmark your host

```bash
# Inside the Docker container:
docker exec -it castnexus-dashboard node tools/music24-benchmark.js --encoder auto --mode auto
docker exec -it castnexus-dashboard node tools/music24-benchmark.js --encoder cpu --mode low --width 1920 --height 1080

# Source install:
cd dashboard && node tools/music24-benchmark.js --encoder nvenc --mode balanced --json result.json
```

Options: `--encoder auto|cpu|nvenc|qsv|vaapi`, `--mode auto|max|balanced|low|ultra`,
`--width/--height/--fps`, `--render-fps N`, `--chromium-gpu true|false|auto`,
`--cpu-safe auto|true|false`, `--warmup S`, `--seconds S`, `--json FILE`.
