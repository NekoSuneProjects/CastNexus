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
