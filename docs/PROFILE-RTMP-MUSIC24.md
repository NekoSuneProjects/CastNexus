# Profile-scoped RTMP and Music 24/7 publishing

CastNexus no longer treats every profile as one account-wide `live/<pcKey>` publisher.

## Per-profile RTMP

Every CastNexus profile receives its own random RTMP key. For a profile with ID `gaming`, the Studio shows:

```text
Server: rtmp://CASTNEXUS_HOST:1935/profile/gaming
Key:    <gaming-profile-key>
```

MediaMTX sees the complete publisher path as:

```text
profile/gaming/<gaming-profile-key>
```

A different profile has a different path **and** a different key:

```text
profile/radio/<radio-profile-key>
```

A key issued to one profile cannot authenticate another profile's path.

This allows multiple encoders/profile publishers to remain connected at the same time. CastNexus only routes the currently selected profile to the stable `public/<twitch-login>` program path and to enabled destinations. Other profile feeds stay connected as standby sources and do not hijack the program.

## Legacy PC path

Existing installs may already have OBS configured with:

```text
rtmp://CASTNEXUS_HOST:1935/live
<old-account-pc-key>
```

During migration, CastNexus associates that legacy key with one original PC profile. The alias remains usable for that profile, but it is **not** reinterpreted every time the active profile changes. New profiles should use the profile-scoped Server + Key shown by the Studio.

Use **Regenerate this profile key** to rotate only the selected profile's credential.

## Music 24/7

A Music profile is also a real profile publisher. The `music24` worker:

1. watches the active profile in `state.json`;
2. requires a Music profile with at least one track and a valid profile RTMP key;
3. starts its internal silence/audio feeder;
4. waits until MediaMTX reports that feeder as ready;
5. renders the profile-specific music scene in Chromium;
6. mixes the active profile's isolated audio library;
7. publishes the composed stream to `profile/<music-profile-id>/<music-profile-key>`;
8. waits until MediaMTX reports that profile path as ready before logging `ON AIR`;
9. lets the dashboard route that selected Music profile to enabled RTMP/RTMPS/SRT destinations.

If startup fails, the worker tears down its partial processes and retries on a later reconciliation instead of remaining in a fake running state.

Useful Docker setting:

```dotenv
MUSIC24_START_TIMEOUT_MS=15000
```

The Docker worker explicitly connects to MediaMTX's local Control API for readiness checks.

## Desktop

The Windows/Linux launcher starts the same Music 24/7 worker in-process after MediaMTX and the CastNexus dashboard start. It also searches common Chrome, Chromium and Microsoft Edge installation paths and exposes the detected browser to the compositor.

Desktop Music 24/7 still requires FFmpeg on the host. A Chromium-family browser must also be installed for browser-rendered overlays and the radio scene.
