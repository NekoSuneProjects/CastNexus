# TODO

- **Overlays, text & music widgets** - **phases 1-3 shipped, plus a v2 pass**
  mirroring CacheStream's actual scene-switch/music mechanics (read in full -
  see the design doc's v2 addendum). Scene pages (Starting Soon / BRB /
  Ending / a self-hiding Live badge) plus custom Text / HTML / Music-player
  overlays are served as OBS Browser Sources from `/overlay/:login/...`, all
  managed from the dashboard's "Overlays & scenes" panel:
  - A **master scene switcher** (`/overlay/:login/master`) lets you change
    what's showing live, no OBS reconfiguration or stream restart - pushed
    via Server-Sent Events (`dashboard/events.js`).
  - Music is a **real shared engine** (`dashboard/music-engine.js`), one
    authoritative "now playing" per account (ffprobe-timed server-side
    advance), not independent per-page playback - so a Music-player overlay
    and a Now Playing widget on another scene stay in sync.
  - See [`dashboard/overlays.js`](dashboard/overlays.js),
    [`dashboard/music-engine.js`](dashboard/music-engine.js),
    [`dashboard/events.js`](dashboard/events.js), and the
    `/api/overlays*` / `/api/scenes/current` / `/api/music/*` routes in
    [`dashboard/server.js`](dashboard/server.js).

  Remaining:
  - **Phase 4**: burning overlays directly into the console-capture video
    pipeline (today zero-cost `-c copy` passthrough, no compositor at all) -
    out of scope until there's real demand; see §5 of the design doc.
  - **OBS-websocket integration** (not built - see the design doc's v2
    addendum): would let the dashboard drive OBS's *own* scene collection
    directly instead of via one master Browser Source. A legitimate
    complement for OBS-mode users specifically, but a separate, sizable
    integration on its own.

  Full design + phased rollout: [`docs/design/overlays.md`](docs/design/overlays.md).
