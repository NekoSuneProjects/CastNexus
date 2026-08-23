# Dual HLS playback: normal + VRChat

CastNexus keeps its primary MediaMTX instance on **Low-Latency HLS** and runs a second lightweight MediaMTX instance for **VRChat / AVPro compatibility**.

Both outputs carry the same `public/<twitch-login>` program stream. The VRChat instance only remuxes the existing H.264/AAC tracks; it does not run a second encoder.

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
        |
        | local RTSP pull (no re-encode)
        v
VRChat MediaMTX
  MPEG-TS HLS :8898
```

The dashboard proxies the two HLS routes as follows:

```text
/hls/*        -> http://127.0.0.1:8888/*
/vrchat-hls/* -> http://127.0.0.1:8898/*
```

This means a normal reverse proxy only needs to forward the CastNexus site to the dashboard. The dashboard handles the internal HLS routing.

If an external proxy overrides `/hls/` with a custom location, leave that route pointed at the primary MediaMTX `:8888`. Either remove a custom `/vrchat-hls/` override and let the dashboard handle it, or point it directly at `:8898` while stripping the `/vrchat-hls/` prefix.

## MediaMTX configs

- `config/mediamtx.yml` — primary MediaMTX, `hlsVariant: lowLatency`
- `config/mediamtx-vrchat.yml` — VRChat compatibility MediaMTX, `hlsVariant: mpegts`

The VRChat instance accepts only `public/*` playback paths and pulls the matching path from the primary server over localhost RTSP on demand.

## Restart after updating

```bash
docker compose pull
docker compose up -d --force-recreate mediamtx mediamtx-vrchat dashboard
```

Check both MediaMTX instances:

```bash
docker compose logs --tail=100 mediamtx mediamtx-vrchat
```

Then, while a profile is live, verify both playlists:

```bash
curl -fsS http://127.0.0.1:8888/public/nekoryza/index.m3u8 | head
curl -fsS http://127.0.0.1:8898/public/nekoryza/index.m3u8 | head
```

The normal endpoint can contain LL-HLS tags such as `#EXT-X-PART`. The VRChat endpoint should use classic MPEG-TS segments and should not contain `#EXT-X-PART`.
