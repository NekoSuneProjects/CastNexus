# TODO

- **Overlays, text & music widgets** - **all 4 phases shipped**, following
  CacheStream's actual mechanics read in full from its real source (not just
  its docs) - see the design doc's v2/v3 addenda for exactly what was
  ported vs. adapted vs. deliberately left out. Scene pages (Starting Soon /
  BRB / Ending / a self-hiding Live badge) plus custom Text / HTML /
  Music-player overlays are served as OBS Browser Sources from
  `/overlay/:login/...`, all managed from the dashboard's "Overlays &
  scenes" panel:
  - A **master scene switcher** (`/overlay/:login/master`) lets you change
    what's showing live, no OBS reconfiguration or stream restart - pushed
    via Server-Sent Events (`dashboard/events.js`).
  - Music is a **real shared engine** (`dashboard/music-engine.js`), one
    authoritative "now playing" per account (ffprobe-timed server-side
    advance), not independent per-page playback - so a Music-player overlay
    and a Now Playing widget on another scene stay in sync.
  - A **built-in compositor** (`dashboard/compositor.js`, opt-in per account
    via `account.compositorEnabled`) is CacheStream's literal mechanism -
    headless Chromium + CDP `Page.startScreencast` + FFmpeg - adapted so the
    same page also plays the account's own live output via WHEP, baking
    overlays directly into what viewers see instead of relying on OBS's own
    Browser Source. Applies to both console and PC/OBS mode. Verified at
    the Puppeteer+screencast+FFmpeg level locally; **not yet verified on
    real target hardware (Raspberry Pi/Docker) or the WHEP-in-browser path
    end to end - experimental.**
  - See [`dashboard/overlays.js`](dashboard/overlays.js),
    [`dashboard/music-engine.js`](dashboard/music-engine.js),
    [`dashboard/events.js`](dashboard/events.js),
    [`dashboard/compositor.js`](dashboard/compositor.js), and the
    `/api/overlays*` / `/api/scenes/current` / `/api/music/*` /
    `/api/compositor` routes in [`dashboard/server.js`](dashboard/server.js).

  Remaining:
  - **Compositor hardening**: hardware-encoder fallback, periodic Chromium
    recycle, memory-pressure recycling - all present in CacheStream's own
    `stream.js`, deliberately not ported yet (see the design doc's v3
    addendum). Worth doing if the compositor sees real usage.
  - **Real hardware validation**: the compositor needs an actual run on a
    Raspberry Pi / the Docker image with a live source to confirm the
    double-decode cost (video decoded once for the WHEP source, again
    inside the browser) is actually viable, not just correct.
  - **OBS-websocket integration** (not built - see the design doc's v2
    addendum): would let the dashboard drive OBS's *own* scene collection
    directly instead of via one master Browser Source or the compositor. A
    legitimate lighter-weight complement for OBS-mode users specifically.

  Full design + phased rollout: [`docs/design/overlays.md`](docs/design/overlays.md).

## Docker parity with the working Desktop app

For Claude to complete later:

- Treat the current Electron/Desktop implementation as the proven reference.
  Port the same complete-frame pacing, audio timing and public playback model
  to the Docker compositor without changing or regressing the Desktop path.
- Read and study commit `7b88456` (`fix: stream complete Electron scene at
  realtime cadence`) before changing the Docker compositor. Reuse its proven
  complete-scene frame pacing approach where it fits Docker; do not blindly
  copy Electron-only assumptions. Compare its changes in
  `dashboard/compositor.js` and `dashboard/compositor.test.js` with the current
  implementation and preserve all later audio/synchronisation fixes.
- Preserve the working Desktop behaviour introduced through commit `68506f3`:
  raw complete-scene frames use wall-clock timestamps, audio cannot accumulate
  behind video, stale audio is discarded on song changes, and the original
  gradient spectrum/progress/cover/background remain smooth.
- Give the Docker audio relay an equivalent isolated timing mechanism. Do not
  allow Chromium rendering or frame encoding to block PCM reads or build a
  hidden TCP/pipe backlog.
- Keep the public MediaMTX path dual-codec: AAC stereo for HLS and Opus stereo
  for WebRTC. Twitch/destination output remains on its separate H.264/AAC path.
- Test inside the real Docker image, not only with unit tests. Verify:
  - the entire scene is visually real-time at the configured output FPS;
  - song audio matches the visible progress/spectrum throughout a full track
    and immediately after at least two automatic song changes;
  - no repeated, doubled, skipped or cut-out audio;
  - WebRTC negotiates H.264 + Opus and is audible;
  - HLS contains audible 48 kHz stereo AAC;
  - Twitch or a local RTMP destination does not buffer or accumulate A/V drift;
  - MediaMTX reports no inbound frame errors;
  - CPU-only Docker remains usable and configured GPU acceleration still works.
- Run the finished Docker image on both target deployment classes:
  - a Raspberry Pi, validating its supported hardware encoder when available
    and a realistic CPU fallback;
  - a Linux VPS, validating CPU-only operation and any configured NVIDIA or
    VAAPI acceleration.
  Record the achieved output FPS, CPU/GPU use, memory use, dropped/duplicated
  frames, and A/V sync on each system. Test WebRTC, HLS and at least one RTMP
  destination for a sustained run that includes multiple automatic song
  changes.
- Measure sync from the encoded output by matching recorded programme audio to
  the source track; do not rely only on FFmpeg's reported FPS or packet presence.
- Before Docker implementation work, create a clearly named snapshot commit or
  branch from the then-current main branch. If the Docker port fails the tests
  above or regresses Desktop, roll back only the Docker implementation to that
  snapshot. Do not remove the known-good Desktop fixes.
- Do not push intermediate Docker experiments as completed fixes. Commit and
  push only after the Docker image passes the end-to-end checks above.

### Docker dashboard playback endpoints

- Expose clear, copyable playback URLs on the Docker dashboard whenever a
  profile is live:
  - WebRTC player: `/webrtc/public/:profile/`
  - WHEP endpoint: `/webrtc/public/:profile/whep`
  - HLS playlist: `/hls/public/:profile/index.m3u8`
- Build each URL from the public dashboard address. Preserve `https://` when
  the dashboard is reached through a domain/reverse proxy, and use `http://`
  when it is reached directly through a local or server IP address. Correctly
  honour trusted forwarded host/protocol headers, and support an explicit
  public-base-URL setting for Docker installations behind another VPS/proxy.
- Show friendly labels rather than raw API property names. Make the HLS URL
  especially prominent as a **VRChat / media-player URL**, with one-click copy
  and open actions. Keep WebRTC, WHEP, RTSP and SRT available for their relevant
  clients.
- Display these endpoints on the relevant dashboard/playback page as well as
  the existing Public Playback settings area, without changing MediaMTX's
  underlying paths or reverse-proxy behaviour.
- Test both access patterns end to end: a public HTTPS domain such as
  `https://castnexus.nekosunevr.co.uk` and a direct HTTP IP/local address such
  as `http://192.168.1.10:8090`. Confirm the copied HLS `.m3u8` URL opens from a
  separate device and can be pasted directly into a VRChat video player.
