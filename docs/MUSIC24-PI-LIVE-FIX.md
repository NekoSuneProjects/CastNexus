# Music 24/7 Raspberry Pi live-publisher fix

This change targets a failure where the Music 24/7 browser preview was visibly playing but CastNexus remained `Idle` and MediaMTX never received the final profile publisher.

## Root cause addressed

On CPU-only hosts Chromium was launched with both:

```text
--disable-gpu
--disable-software-rasterizer
```

That combination can leave a headless CPU-only Chromium instance without a usable raster path for CDP screencasting. The overlay page can load, while the compositor never receives a frame to feed FFmpeg. The internal `music-silence/...` path therefore becomes ready, but `profile/<profile-id>/<profile-key>` never appears.

CPU fallback now disables GPU acceleration **without disabling Chromium's software rasterizer**.

The compositor also waits for a real first Chromium frame before reporting itself as running. If no frame arrives within `COMPOSITOR_FIRST_FRAME_TIMEOUT_MS` (default 10 seconds), startup fails with a concrete error instead of leaving Music 24/7 looking healthy while the program remains Idle.

## Pi startup window

The dashboard image now defaults `MUSIC24_START_TIMEOUT_MS` to 60 seconds. Raspberry Pi Chromium + FFmpeg cold starts can take longer than x64 hosts, especially with software x264.

## Real end-to-end validation

The dedicated `Music 24/7 End-to-End` workflow starts a real MediaMTX instance, creates a temporary Music profile and audio track, starts CastNexus with Chromium + FFmpeg, and requires both paths to become ready:

```text
profile/radio/<profile-key>
public/music-ci
```

This validates the actual broadcast path rather than only checking that the worker process started.

## Recommended Docker update

Use the repository Compose file when possible. For older custom stacks, ensure the dashboard has at least:

```yaml
environment:
  MEDIAMTX_API: http://127.0.0.1:9997
  MEDIA_RTMP_ORIGIN: rtmp://127.0.0.1:1935
  STATE_FILE: /app/data/state.json
  MUSIC_DIR: /app/data/music
  MUSIC24_START_TIMEOUT_MS: 60000
```

For temporary troubleshooting you can also add:

```yaml
  COMPOSITOR_DEBUG: "true"
```

Then inspect:

```bash
docker logs castnexus-dashboard --since=5m | grep -E 'music24|compositor'
```
