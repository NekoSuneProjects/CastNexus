# Design: Overlays, text & music widgets

Status: **Phases 1-3 shipped** (see §6) · Phase 4 (PS5-mode compositor) not
started - no blocker, just no demand yet

> Implementation notes vs. the original design below, kept for history:
> - Built-ins ended up as **Starting Soon / BRB / Ending / a self-hiding Live
>   badge** (`/overlay/:login/live` + `/overlay/:login/live-status.json`,
>   polling this project's own live-detection state instead of a generic
>   "stream stats" widget).
>   Config lives on the account (`account.overlayConfig`), edited via
>   `GET/POST /api/overlays/config` - same shape as §4.2 proposed.
> - Custom scenes narrowed to exactly the three types requested - **`html`
>   (raw passthrough, unescaped by design), `text` (escaped), and `music`**
>   - CRUD'd via `/api/overlays` (`{ id, name, slug, type, config }`), no
>     `raw_html`/`generic`/templated split like CacheStream's five types.
> - Music went with the **simpler of the two options floated in §4.4**: no
>   `/api/music/now` polling contract or separate now-playing widget:
>   the `music` overlay type is a single self-contained page (`<audio>` +
>   its own now-playing card) that IS the OBS Browser Source, autoplaying
>   through the account's whole uploaded library (`account.musicTracks`,
>   `POST /api/music/tracks` with `multer`). One library per account, not
>   per-overlay playlists - if that's ever needed, `config.trackIds` on the
>   overlay is the extension point.
> - Overlay URLs are unauthenticated by the same trust model as the
>   `public/<login>` playback paths (§4.1's proposal) - no per-account token
>   was added.

> **v2 addendum - after actually reading CacheStream's code (not just its
> READMEs) for its scene-switch and music mechanics:**
> - **Critical finding**: CacheStream doesn't use OBS at all. It replaces
>   OBS with its own headless-browser capture worker (Puppeteer/Electron)
>   that navigates between scene URLs and captures the frames itself via
>   FFmpeg - that's the actual mechanism behind "switch scenes without
>   touching OBS." Porting that literally would mean this project stops
>   being an OBS/console restream tool and becomes its own compositor -
>   explicitly out of scope, contradicts the whole point of the project.
> - What *is* portable, and was ported: a **server-authoritative "current
>   scene" state pushed live to whatever's rendering it**. Since we don't
>   own the browser tab (OBS does, unlike CacheStream), the mechanism is
>   adapted rather than copied: one stable **master overlay**
>   (`/overlay/:login/master`) is added ONCE as a Browser Source; switching
>   scenes (`POST /api/scenes/current`) updates `account.currentScene` and
>   pushes the newly-rendered fragment over **Server-Sent Events**
>   (`/overlay/:login/events`, `dashboard/events.js` - a scaled-down version
>   of CacheStream's `lib/bus.ts`+`lib/sse.ts`), and the already-loaded page
>   swaps its content in place - no navigation, no OBS reconfiguration, no
>   stream restart. Individual scene routes (`/starting-soon` etc.) are
>   unchanged and still work standalone.
> - **Music went from "independent per-page playback" to a real shared
>   engine** (`dashboard/music-engine.js`), directly mirroring CacheStream's
>   single `MusicEngine` instance (`apps/web/src/lib/music.ts`): one
>   authoritative "what's playing and how far into it" per account, timer-
>   driven server-side advance (needs each track's duration, probed via
>   `ffprobe` on upload - already bundled with `ffmpeg` in the Docker image),
>   exposed at `/overlay/:login/music/now.json`. What's deliberately NOT
>   ported is CacheStream's FFmpeg→FIFO audio-mixing pipeline into a
>   compositor - this project has no compositor to feed (see the original
>   note above), so actual playback still happens client-side via each
>   overlay's own `<audio>` element; it just joins the server's timeline
>   (seeks to the current position) instead of picking independently. This
>   is what makes multiple overlays (a dedicated Music-player overlay AND a
>   Now Playing widget on a different scene) agree.
> - Added a **Now Playing mini-widget**, layerable onto any scene via
>   `account.overlayConfig.nowPlaying` - the one CacheStream
>   `OverlayConfigCard` widget this project ported so far (§4.2's proposal,
>   finally implemented). `withWidgets()` in `dashboard/overlays.js` is the
>   shared-wrapper equivalent of CacheStream's `SceneFrame.tsx`.
> - Volume/shuffle/loop moved from per-overlay `config` to account-level
>   `account.musicSettings` - there's one shared engine, so one set of
>   playback settings, matching CacheStream's own model (its Music admin tab
>   configures the one engine, not each scene individually).
> - **Not built**: OBS-websocket integration. It's the "correct" way to get
>   literal OBS scene/source control (OBS 28+ ships a websocket server
>   precisely for this), and would be a legitimate alternative/complement to
>   the master-switcher approach for OBS-mode users specifically - but it's
>   a separate, sizable integration (protocol handshake, per-user
>   host/port/password config) that doesn't help console-mode users at all.
>   Worth a future TODO if there's demand for controlling OBS's own scene
>   collection directly rather than adding one master Browser Source.

## 1. Goal

Let people drop overlays (lower-thirds, alerts, a "now playing" music card,
plain text) onto their stream, and manage them from this dashboard - the way
[CacheStream](../../../../Forked%20Projects/CacheStream) does it, but scoped
to a restream tool with two very different ingest paths (OBS push vs. PS5
console capture) instead of CacheStream's own always-there compositor.

## 2. How CacheStream does it (reference)

Read directly from the CacheStream repo before implementing - this is a
summary, not a spec:

- **Scene pages are just web routes**, meant to be added as an OBS Browser
  Source (or stacked via iframe): `apps/web/src/app/scene/*` in CacheStream,
  e.g. `/scene/starting-soon`, `/scene/brb`, `/scene/custom/:slug`. Each is a
  transparent-background HTML/CSS/JS page.
- **Built-in scene list** lives in
  `apps/web/src/app/admin/tabs/ScenesTab.tsx` - a fixed `BUILTINS` array
  (name, path, description) shown read-only, plus **custom scenes** the
  operator creates from templates (`starting_soon`, `brb`, `ending`,
  `generic`, `raw_html`), CRUD'd via `/api/scenes/custom`
  (`{ id, slug, name, template, config }`). `raw_html` lets the operator
  paste arbitrary HTML/CSS - the escape hatch for anything the templates
  don't cover.
- **Global overlay toggles** (`apps/web/src/app/admin/tabs/OverlayConfigCard.tsx`)
  are a separate concern from scenes: small persistent widgets (Now Playing
  card, chat box, alerts ticker, stream-stats badge) that can be turned on
  per-corner and layered on *every* scene, read/written via
  `GET/POST /api/overlays/config`. Saves are immediate, no explicit save
  button - the config blob is tiny.
- **Widgets are dumb pollers.** E.g. `examples/scenes/now-playing-card/scene.html`
  polls `GET /api/music/now` every second and renders cover art (from
  `GET /api/music/cover/:trackId`) + title/artist, hiding itself when idle.
  No websockets needed for this class of widget - see
  `examples/scenes/now-playing-card/README.md` for the exact JSON contract.
- Crucially: **CacheStream already has its own compositor.** Its streamer
  process (`apps/streamer/src`) is the thing capturing/encoding video, so
  "add an overlay" just means "OBS/its own renderer loads another browser
  source" - there's no separate video pipeline step needed to burn it in.

## 3. Why this is harder here

This project has **two ingest paths that don't share a compositor**:

- **OBS mode** - the user's own OBS is already compositing before anything
  reaches this box. Adding an overlay here is *exactly* CacheStream's
  model: serve scene pages, let the user add them as their own OBS Browser
  Sources on top of their game capture. **Zero changes to the media
  pipeline** - this phase is pure "serve some HTML," no ffmpeg involved.
- **PS5 mode** - there is no compositor at all today.
  `dashboard/server.js` (`startDestination` / `startRepublish`) runs plain
  `ffmpeg -c copy` passthrough: the PS5's own encode goes straight to
  destinations untouched. To actually burn an overlay onto *that* video, a
  real filter/transcode stage has to be inserted for the first time -
  see §5.

So phase 1 (serve overlay pages + config) benefits OBS-mode users
immediately and costs nothing. Burning overlays into the PS5-mode output is
a separate, higher-risk phase (§5) that should be scoped and reviewed on its
own once phase 1-3 exist and someone actually wants it.

## 4. Proposed design (phases 1-3, low risk)

### 4.1 Overlay/scene pages

Serve them from the existing `dashboard` Express app (no new service) under
a per-account path, since this dashboard is already multi-account:

```
GET /overlay/:twitchLogin/scene/:name        (built-ins: starting-soon, brb, ending, offline, generic)
GET /overlay/:twitchLogin/scene/custom/:slug (operator-authored)
GET /overlay/:twitchLogin/widgets            (the always-on corner-widget layer, config-driven)
```

These are **public, unauthenticated GETs** (OBS Browser Source can't do
Twitch login) - scope them by the account's own login/slug being
effectively unguessable-enough for a LAN tool, same trust model this
project already uses for `public/<twitch-username>` playback paths. Static
HTML/CSS, transparent background, polling JS - same pattern as
CacheStream's example scenes.

### 4.2 Overlay config API (per-account)

Mirror `OverlayConfigCard.tsx` / `/api/overlays/config`:

```
GET/POST /api/overlays/config      (auth required - operator's own dashboard session)
{
  text:        { enabled, corner, content },       // static/lower-third text
  nowPlaying:  { enabled, corner },
  alertsTicker:{ enabled },                         // "X is now pushing to Twitch" etc? or left as a text feed the operator edits
  streamStats: { enabled, corner }                  // live/idle, uptime, which destinations are active
}
```

`streamStats` is a natural fit here specifically because the dashboard
already tracks `liveSessions` / `activeDestinations` - it can serve stats
this project already computes, no new data source needed.

### 4.3 Custom scenes CRUD

Same shape as CacheStream's: `{ id, slug, name, template, config }`,
templates `starting_soon | brb | ending | generic | raw_html`, persisted in
the existing `state.json` under each account (alongside `destinations`).
Reuse CacheStream's field names where they overlap so example scenes/READMEs
are portable with minimal edits.

### 4.4 Now-playing / music widget

Adopt CacheStream's exact contract so its example scene
(`examples/scenes/now-playing-card/scene.html` in CacheStream) can be reused
almost as-is:

```
GET /api/music/now   -> { mode: "library"|"radio"|"idle", nowPlaying?: { trackId, title, artist, album, coverPath, durationS, startedAt } }
GET /api/music/cover/:trackId
```

This project has no music player of its own, so `nowPlaying` needs a
source. Cheapest option: a small `POST /api/music/now` the operator's own
media player pushes to (a Winamp/foobar2000/Spotify-status plugin, or a tiny
script polling the OS's now-playing session) - out of scope to build a full
music service; just define the contract and accept pushes to it.

### 4.5 Dashboard UI

New "Overlays" tab/panel (`dashboard/public/index.html` currently has no
tabs - add one) mirroring CacheStream's `OverlayConfigCard` + `ScenesTab`:
toggle widgets on/off with a corner picker, template picker for new custom
scenes, a raw HTML/CSS editor, "Copy URL" / "Open preview" buttons for each
scene using the `/overlay/:twitchLogin/...` paths from §4.1.

## 5. PS5-mode compositor (phase 4, higher risk - separate effort)

To burn an overlay into the actual outgoing video when the source is the
PS5's own broadcast (no OBS involved), `startDestination`/`startRepublish`
need a **new opt-in transcode path** instead of today's `-c copy`:

- Render the overlay to a live image/video feed a filtergraph can read -
  e.g. a small headless-Chromium (Puppeteer/Playwright) process screenshotting
  the same `/overlay/:twitchLogin/widgets` page at N fps to a named pipe or
  looping file, or a lightweight canvas/text renderer if full HTML/CSS is
  overkill for what's actually needed (mostly text + a corner card).
- Feed it into ffmpeg as a second input, composited with `overlay=`/`drawtext=`
  filters ahead of `-c:v libx264` (can no longer be `-c copy` - this is a
  real CPU cost the Pi doesn't pay today).
- Make it **strictly opt-in per account/destination**, default off, and
  call out in the dashboard UI that enabling it switches that stream from
  zero-cost passthrough to an actual encode. Cheap Pis (3B/4) may not keep
  up at the PS5's typical 1080p60 - profile before shipping this as
  anything but experimental.
- Alternative worth considering instead of burning it in: leave PS5-mode
  video untouched and only offer the overlay pages for **secondary use**
  (a phone/monitor "now playing" display, an embed on a companion page) -
  much lower effort, no transcode, but doesn't satisfy "overlay on the
  actual stream" for console users. Decide this tradeoff explicitly before
  starting phase 4; it may be the right permanent answer rather than a
  stepping stone.

## 6. Staged rollout

1. ✅ Overlay/scene page serving + built-in templates (§4.1) - OBS-mode users
   get value immediately, zero pipeline risk.
2. ✅ Overlay config API + dashboard UI tab (§4.2, §4.5).
3. ✅ Custom scenes CRUD + music (§4.3, §4.4) - see the implementation-notes
   callout at the top for exactly how this diverged from the original plan.
4. ⬜ PS5-mode compositor (§5) - only after 1-3 exist and there's real demand;
   scope/review as its own change since it's the first time this project
   would ever re-encode the console's video instead of copying it. 1-3
   shipped without needing this at all - it stays purely optional.

## 7. Open questions

- Should overlay page URLs be authenticated at all (e.g. a per-account
  token in the query string), or is the existing "unguessable path" trust
  model (same as `public/<twitch-username>` playback URLs) good enough?
- Any real demand for phase 4 (burned-in PS5 overlays), or is "overlay
  pages for secondary displays only" the right permanent scope for console
  mode?
- Cap on custom scenes per account, and on raw-HTML size/content (same
  "you're trusted, but typos break the broadcast" tradeoff CacheStream
  already accepts for `raw_html`)?
