# Design: Overlays, text & music widgets

Status: **TODO / not started** · Depends on: nothing blocking - can start anytime

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

1. Overlay/scene page serving + built-in templates (§4.1) - OBS-mode users
   get value immediately, zero pipeline risk.
2. Overlay config API + dashboard UI tab (§4.2, §4.5).
3. Custom scenes CRUD + now-playing/music contract (§4.3, §4.4).
4. PS5-mode compositor (§5) - only after 1-3 exist and there's real demand;
   scope/review as its own change since it's the first time this project
   would ever re-encode the console's video instead of copying it.

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
