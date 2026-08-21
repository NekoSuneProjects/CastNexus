# Profile Music Isolation & Dual-Format Outputs

CastNexus profiles now own their music instead of sharing one account-wide playlist.

## Profile-isolated music

Each profile has a separate music state, timeline and storage directory:

```text
dashboard/data/music/
└── <twitch-account-id>/
    ├── <pc-gaming-profile-id>/
    │   ├── track-a.mp3
    │   └── track-b.flac
    ├── <console-profile-id>/
    │   └── track-c.ogg
    └── <24-7-radio-profile-id>/
        ├── radio-01.mp3
        └── radio-02.mp3
```

The matching public browser-source route is also profile-scoped:

```text
/overlay/<login>/music/<profile-id>
/overlay/<login>/music/<profile-id>/now.json
/overlay/<login>/music/<profile-id>/file/<track-id>
```

A track ID is looked up only inside the requested profile. A track from another profile is rejected instead of falling back to a global library.

### Existing installs

Pre-profile/account-wide music is migrated once into the active/first profile. CastNexus moves the old files into that profile directory where possible and records that the migration has happened.

## Gaming profile BRB / Ending music

PC and Console profiles can enable **Play on standby scenes** from **Music / 24/7**.

When enabled, that profile's music can play on:

- Starting Soon
- BRB
- Ending

It does not replace normal gameplay/program audio. The browser-source master scene mounts a hidden audio-only player while one of those scenes is active, and removes it when the scene changes back. The built-in compositor uses the same active-profile rule for its server-side audio mix.

This isolation prevents a Gaming profile from accidentally using tracks uploaded to a separate 24/7 Radio profile. It does not grant rights to music: you still need to follow the licence/attribution rules for every track you use (including NCS or other creator-music libraries).

## Profile canvas

Every profile has a default canvas:

- **16:9 Landscape** — desktop, TV, normal Twitch/YouTube-style viewing
- **9:16 Vertical** — TikTok-style, Instagram/Reels-style, YouTube Shorts/live vertical viewing

The Music scene has a purpose-built portrait layout in 9:16 rather than merely cropping the horizontal design.

## Destination layout override

Each destination can independently choose:

- **Source / passthrough** — no video re-encode
- **16:9 Landscape** — server encodes 1920×1080
- **9:16 Vertical** — server encodes 1080×1920

This means one incoming PC/console source can feed multiple layout-specific destinations at the same time. Forced layouts require FFmpeg video encoding and therefore use significantly more CPU/GPU than Source/passthrough.

## YouTube horizontal + vertical

YouTube supports simultaneous horizontal and vertical live streams. For third-party encoders, YouTube's current documentation recommends RTMP(S) and provides a second stream key for the vertical stream when the feature is available to the creator.

Typical CastNexus setup:

```text
OBS / Console
      │
      ▼
  CastNexus
      ├── YouTube horizontal key → 16:9 Landscape
      └── YouTube vertical key   → 9:16 Vertical
```

Enable **Dual stream** in YouTube Live Control Room, select the third-party **Encoder** option, use the normal key for horizontal and the second key for vertical, then add both as CastNexus destinations.

YouTube reference:
https://support.google.com/youtube/answer/2474026

## Twitch Dual Format and viewer quality choices

Twitch is different from a normal two-key RTMP destination.

As of June 2026, Twitch says Dual Format is available to all streamers and is built on **Enhanced Broadcasting**. Enhanced Broadcasting uses the broadcasting client to encode multiple variants. Twitch also says it supplies additional server-side transcoding for Partners and many Affiliates in supported Enhanced Broadcasting modes.

That means a normal CastNexus RTMP relay cannot send one ordinary 1080p RTMP stream and set a flag that forces Twitch to create 720p/480p/360p viewer choices. Transcoding availability is controlled by Twitch and its Enhanced Broadcasting pipeline/eligibility.

If guaranteed Twitch quality variants or native Twitch Dual Format are important, use a compatible broadcaster such as OBS with Twitch Enhanced Broadcasting directly to Twitch, while using CastNexus in parallel for your other restream destinations. CastNexus can still create a 16:9 or 9:16 RTMP encode, but that alone does not activate Twitch Enhanced Broadcasting.

Twitch references:
https://blog.twitch.tv/en/2026/06/17/introducing-dual-format-and-2k-streaming-on-twitch/
https://help.twitch.tv/s/article/enhanced-broadcasting
https://help.twitch.tv/s/article/dual-format-vertical-video
