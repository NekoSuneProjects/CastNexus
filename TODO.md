# TODO

- **Overlays, text & music widgets** - **phases 1-3 shipped.** Scene pages
  (Starting Soon / BRB / Ending / a self-hiding Live badge) plus custom
  Text / HTML / Music-player overlays are served as OBS Browser Sources from
  `/overlay/:login/...`, managed from the dashboard's "Overlays & scenes"
  panel. See [`dashboard/overlays.js`](dashboard/overlays.js) and the
  `/api/overlays*` / `/api/music/tracks*` routes in
  [`dashboard/server.js`](dashboard/server.js).
  Remaining: **phase 4**, burning overlays directly into the console-capture
  video pipeline (which today is zero-cost `-c copy` passthrough with no
  compositor at all) - out of scope until there's real demand; see §5 of the
  design doc. Full design + phased rollout:
  [`docs/design/overlays.md`](docs/design/overlays.md).
