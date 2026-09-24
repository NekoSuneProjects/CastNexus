# Overlay Studio, scenes and per-destination layouts

OBS (or a console) sends **one** master stream to CastNexus. CastNexus then adds
overlays, browser-source audio, Starting Soon / BRB / Ending scenes and separate
horizontal and vertical layouts on the server, and sends each destination the
layout it needs.

```text
                         ┌─ Horizontal program (16:9 scene) ─┬─ Twitch   (stream copy)
OBS ─► MediaMTX ─► raw ──┤                                   ├─ YouTube  (stream copy)
                         │                                   └─ Kick 720p60 (shared re-encode)
                         ├─ Vertical program (9:16 scene) ───── TikTok / Shorts (stream copy)
                         └─ Source / Passthrough ────────────── any destination (no decode/encode)
```

## Scenes and layers

A scene is a canvas (1920×1080, 1080×1920 or any custom size) with ordered
layers. Layer types:

Gameplay / OBS, StreamElements, Streamlabs, browser source, alert box, chat,
custom webpage, iframe, image, animated GIF, video, text, clock, countdown,
music widget, Now Playing, webcam frame, background, colour block, gradient,
custom HTML and custom CSS.

The editor (**Overlay Studio** in the sidebar) supports:

- drag, resize (Shift keeps the aspect ratio), rotate and set opacity
- snapping to the grid, canvas edges, the centre and other layers, with guides
- arrow keys to nudge 1 px (Shift+arrow nudges 10 px); Ctrl+D duplicates;
  Del deletes; Ctrl+Z and Ctrl+Y undo and redo
- lock, hide/show, reorder (drag in the Layers list, or use ▲/▼), and centre
  horizontally or vertically
- mouse and touch input (pointer events)
- **Gameplay framing:** Fit / Fill / Crop / Stretch, scale, X/Y position and
  crop on all four sides. Double-click the gameplay layer (or hold Alt while
  dragging) to move the picture inside its box.
- safe-area guides for vertical platforms (text-safe zone, UI and caption
  obstruction zones, centre lines). These are drawn only in the editor and in
  `?preview=1&guides=1` previews. They are never rendered into the broadcast.
- a **Live content** toggle, which renders real browser sources inside the
  editor. It runs in your own browser only, never in the server renderer.

Default scenes are created automatically: Gameplay, Just Chatting, Vertical
Gameplay, Vertical Just Chatting and Music. You can create, rename, duplicate
and delete scenes; each orientation must keep at least one scene.

### Switching live

- The **●** button next to a scene makes it the live scene for its orientation.
- **On air** buttons (Live / Gameplay, Starting Soon, BRB, Ending, Offline)
  switch every output at once.

Both only publish an SSE event to the program pages, which reconcile their
layers in place. FFmpeg, MediaMTX paths and destinations are not restarted.
Layers whose content has not changed (for example a StreamElements alert
widget) are not reloaded when other layers are moved, re-ordered or change
volume.

## Starting Soon, BRB, Ending and Offline

Each slot can show:

| Mode | What it shows |
|---|---|
| Built-in | the original CastNexus scene (countdown, socials, optional profile music) |
| Overlay Studio scene | any scene you built |
| StreamElements / browser URL | a full-screen browser source, including its audio |
| Custom HTML | your own HTML/CSS/JS, sandboxed, with its audio |
| Image / video | a background image or looping video, with its audio |

## Browser-source audio

StreamElements alerts, browser music, videos and custom HTML can all make sound.

```text
Chromium renderer (sandbox and site isolation unchanged)
   └─ PULSE_SINK=cn_<renderer>   private PulseAudio null sink in the container
        └─ ffmpeg -f pulse       48 kHz stereo PCM
             └─ paced PCM relay  "Browser sources" mixer bus, live gain
                  └─ amix with the OBS/program bus and the music bus ─► encoder
```

- Capture is only switched on when some scene or slot contains an audible
  layer. Otherwise Chromium keeps `--mute-audio`, which is the cheapest option.
- Per-layer **volume / mute** is applied inside each iframe's own document
  through DevTools. It scales `<audio>`/`<video>` elements and Web Audio graphs,
  so several overlays can play at once at independent levels.
- **Monitor** per layer: *Output* is mixed into the broadcast. *Server only*
  keeps the source rendered but not broadcast. *Off* mutes it.
- The **Audio mixer** (OBS / program, browser sources, scene music) applies
  volume, mute and solo inside the PCM relays. Changes take effect within tens
  of milliseconds and never restart FFmpeg.
- Autoplay works through `--autoplay-policy=no-user-gesture-required` and
  `allow="autoplay"`. This is a playback policy and grants no host privileges.
- Requires the Docker/Linux runtime (the image ships `pulseaudio`). On the
  Windows desktop app, browser sources render but their audio is not captured.

## Security of browser sources

Browser sources are untrusted web content:

- Third-party URLs load in `sandbox="allow-scripts allow-same-origin
  allow-presentation"` iframes. They keep their *own* origin (StreamElements
  needs its cookies/storage) and never get CastNexus' origin, so they cannot
  read the dashboard, its session or its APIs. No popups, forms or top
  navigation are allowed.
- Loopback URLs (`localhost`, `127.x`) would share the renderer's origin, so
  they get an opaque origin (no `allow-same-origin`).
- Custom HTML runs in an opaque-origin `srcdoc` sandbox.
- The renderer enables Chromium's Private/Local Network Access protections
  (`CASTNEXUS_BROWSER_BLOCK_LOCAL_NETWORK=true`). A public overlay page
  therefore cannot call the MediaMTX API, the dashboard or other loopback
  services on the host network.
- The renderer runs with a fresh profile that holds no session cookie, the
  Docker socket is never mounted, and no environment secrets are passed to
  pages. Only URLs are http(s); `javascript:`, `data:` and `file:` are
  rejected.
- No StreamElements API key or credentials are needed: an overlay URL is
  rendered like an OBS browser source.

## Per-destination output layout

Edit a destination to choose:

| Setting | Options |
|---|---|
| Output mode | Source / Passthrough, Horizontal 16:9, Vertical 9:16, Custom (any W×H) |
| Scene | follow the live scene for that orientation, or pin a specific scene |
| Resolution | Match program (stream copy), presets, or custom |
| FPS | Match program, 24–60 |
| Video encoder | Auto, NVENC, QuickSync, VAAPI, AMF, CPU x264 (probed, with fallback) |
| Video bitrate | Match program or kbps |
| Audio | 96–320 kbps, 44.1/48 kHz |
| Caption mode | Off, OBS caption passthrough, server-generated (planned), burn-in (planned) |
| Framing | fit/fill/crop/stretch, scale and offset for vertical output when the compositor is off |

How CastNexus decides what to run:

- **Source / Passthrough:** `-c:v copy` of the raw feed. No decode, no encode,
  no overlays.
- **Match program:** a stream copy of the horizontal or vertical program
  encode. Any number of destinations share one browser render and one encode
  per orientation.
- **Different size, FPS, bitrate or encoder:** one re-encode of the program.
  Destinations with *identical* settings share that re-encode (a "shared
  rendition", `DESTINATION_SHARED_RENDITIONS=true`).
- **Program renderers run on demand.** The vertical program only exists while
  a 9:16 destination is live, and each renderer stops `PROGRAM_IDLE_STOP_MS`
  after its last consumer. An all-passthrough setup never launches Chromium.
- **Legacy destinations** (created before this update) keep their exact
  previous behaviour until you edit and save them.

Program sizes are set under **Overlay Studio → Program output settings**
(defaults: 1280×720 and 720×1280 at `COMPOSITOR_FPS`).

## Stability

Every destination and shared rendition is a supervised FFmpeg worker:

- restarts use exponential backoff (`DESTINATION_RESTART_MIN_MS` →
  `DESTINATION_RESTART_MAX_MS`), reset after 30 s of healthy running
- failures are classified (broken pipe, connection refused/reset, rejected
  key, DNS, timeout, missing source, encoder) and shown on the Destinations page
- a hardware encoder that dies within 8 s moves down the chain
  NVENC → QSV/VAAPI → x264
- stopped workers get SIGTERM, then SIGKILL after 4 s, so no zombie FFmpeg
  processes are left behind
- a destination waits (without counting a failure) while its program renderer
  is still starting

## Closed captions (architecture)

`captions.js` defines the Caption Mode per destination and a provider
interface (`registerCaptionProvider`). *OBS caption passthrough* works today
for stream-copy destinations and for re-encodes on x264/NVENC/QSV/AMF
(`-a53cc 1`). It cannot survive the browser compositor, which re-renders the
picture; the UI says so. *Server-generated* and *burn-in* are wired through the
destination pipeline but stay disabled until a provider (for example Whisper /
whisper.cpp) is installed, so enabling them later needs no routing changes.

## Performance monitoring

**Overview** and **Settings** show system CPU/RAM, CPU per program renderer,
per Music 24/7 component, per destination and shared rendition, the active
encoder, both program sizes and each destination's state. Samples are cached
(2 s on Linux via `/proc`, at least 15 s on Windows), so the dashboard's 3 s
refresh stays cheap.

## Data and upgrades

`state.json` gains `account.sceneLibrary` (created from defaults on first
start) and optional `destination.output`. Nothing is removed or renamed:
existing overlays, `overlayConfig`, `currentScene`, profiles, destinations,
music and recordings keep working, and there is no need to delete
`dashboard/data`.
