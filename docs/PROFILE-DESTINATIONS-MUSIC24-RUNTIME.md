# Profile destinations + embedded Music 24/7 runtime

This change fixes two runtime behaviours that previously looked profile-aware in the Studio but were still account-global underneath.

## Destinations are now owned by the profile

The old state model stored one account-wide `destinations` array. Profiles only remembered which IDs should be enabled, so editing a YouTube/Twitch/SRT URL in one profile could affect another profile.

CastNexus now persists private destination configuration as:

```text
account.destinationProfiles[profileId][]
```

Each profile therefore owns its own:

- destination name
- RTMP / RTMPS / SRT URL and stream key
- Source / 16:9 / 9:16 layout
- enabled state

Destination URLs remain server-side and are not copied into the browser-visible profile overlay object.

### Migration

On the first start after upgrading, the previous global destination set is cloned into every profile that already exists. This preserves the current routes while making later edits independent. Profiles created after migration start with an empty destination list.

The old list is retained in `legacyDestinations` as a migration snapshot, while normal runtime reads/writes switch to the active profile bucket.

## Music 24/7 is part of the dashboard runtime

Docker used to run `music24.js` as a separate Compose service. This allowed the Studio and radio preview to be healthy while the actual broadcaster sidecar was absent, stale, stopped or failing.

The dashboard image now starts through `server-entry.js`:

```text
CastNexus dashboard container
├── Studio / API
└── Music 24/7 worker
```

If the dashboard container is running, the Music 24/7 reconciler is running too. It watches the selected Music profile, starts its Chromium/FFmpeg compositor and publishes to that profile's MediaMTX RTMP path.

The old standalone `node music24.js` mode is disabled unless `MUSIC24_STANDALONE=true` is explicitly set for a custom legacy deployment.

## Updating an existing Docker install

Because the old Compose file contained a separate `castnexus-music24` service, remove orphaned containers when moving to this version:

```bash
docker compose pull
docker compose up -d --remove-orphans
```

This removes the old sidecar so only the embedded dashboard worker owns Music 24/7 publishing.
