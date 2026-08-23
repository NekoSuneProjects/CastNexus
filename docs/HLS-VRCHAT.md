# Dual HLS playback: normal + VRChat

CastNexus keeps its primary MediaMTX instance on **Low-Latency HLS** and runs a second lightweight MediaMTX instance for **VRChat / AVPro compatibility**.

The normal public path intentionally contains two audio tracks: **AAC** for HLS and **Opus** for WebRTC. Classic MPEG-TS HLS supports only one audio track, so CastNexus uses a small `vrchat-relay` sidecar to select **H.264 + the first AAC track only** before publishing to the VRChat MediaMTX instance.

The relay uses stream copy (`-c:v copy -c:a copy`), so there is no second video/audio encode.

## Public endpoints

For a public playback path such as `public/nekoryza`:

```text
Normal / Low-Latency HLS
https://castnexus.example.com/hls/public/nekoryza/index.m3u8

VRChat / MPEG-TS HLS
https://castnexus.example.com/vrchat-hls/public/nekoryza/index.m3u8
```

The dashboard generates both links automatically from the configured Public Base URL.

## Internal layout

```text
publisher / CastNexus program
        |
        v
primary MediaMTX
  RTMP :1935
  RTSP :8554
  LL-HLS :8888
  public/* = H.264 + AAC + Opus
        |
        | vrchat-relay (FFmpeg stream copy)
        | selects video + AAC track 0 only
        v
VRChat MediaMTX
  local RTSP ingest 127.0.0.1:8564
  public/* = H.264 + AAC
  MPEG-TS HLS :8898
```

The dashboard proxies the two HLS routes as follows:

```text
/hls/*        -> http://127.0.0.1:8888/*
/vrchat-hls/* -> http://127.0.0.1:8898/*
```

This means a normal reverse proxy only needs to forward the CastNexus site to the dashboard. The dashboard handles the internal HLS routing.

If an external proxy overrides `/hls/` with a custom location, leave that route pointed at the primary MediaMTX `:8888`. Either remove a custom `/vrchat-hls/` override and let the dashboard handle it, or point it directly at `:8898` while stripping the `/vrchat-hls/` prefix.

## Components

- `config/mediamtx.yml` — primary MediaMTX, `hlsVariant: lowLatency`
- `dashboard/vrchat-relay.js` — watches live `public/*` paths and copies only H.264 + AAC to the VRChat instance
- `config/mediamtx-vrchat.yml` — local RTSP ingest on `127.0.0.1:8564`, `hlsVariant: mpegts`
- `castnexus-vrchat-relay` — Compose sidecar using the dashboard image because it already includes FFmpeg

## Restart after updating

```bash
git pull origin main
docker compose pull
docker compose up -d --force-recreate mediamtx-vrchat vrchat-relay dashboard
```

Check the VRChat components:

```bash
docker compose logs --tail=100 mediamtx-vrchat vrchat-relay
```

While a profile is live, the relay should report:

```text
[vrchat-relay] public/nekoryza: AAC-only RTSP relay started
```

and MediaMTX should report a publisher and MPEG-TS HLS muxer for the same path.

Verify both playlists:

```bash
curl -fsS http://127.0.0.1:8888/public/nekoryza/index.m3u8 | head
curl -fsS http://127.0.0.1:8898/public/nekoryza/index.m3u8 | head
```

The normal endpoint can contain LL-HLS tags such as `#EXT-X-PART`. The VRChat endpoint should use classic MPEG-TS segments and should not contain `#EXT-X-PART`.

You can also verify that the VRChat path has only one audio stream:

```bash
ffprobe -v error -rtsp_transport tcp \
  -show_entries stream=index,codec_type,codec_name \
  -of default=noprint_wrappers=1 \
  rtsp://127.0.0.1:8564/public/nekoryza
```

Expected codecs are H.264 video plus a single AAC audio track.
