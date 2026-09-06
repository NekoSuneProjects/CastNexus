# CastNexus vrchat-relay

A small standalone sidecar that makes a CastNexus stream playable inside
VRChat/AVPro.

The normal public MediaMTX path intentionally carries two audio tracks - AAC
for HLS and Opus for WebRTC. Classic MPEG-TS HLS (what AVPro expects) only
supports one audio track, so this relay selects **video + the first (AAC)
track only** and republishes it, via stream copy (no re-encode), to a second
MediaMTX instance dedicated to VRChat compatibility.

See [`docs/HLS-VRCHAT.md`](docs/HLS-VRCHAT.md) for the full picture.

## Running it

```bash
docker compose up -d
```

This starts `mediamtx` (the normal instance), `mediamtx-vrchat` (the
VRChat-compatible instance) and `vrchat-relay` itself.
