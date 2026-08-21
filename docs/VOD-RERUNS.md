# CastNexus Reruns / VOD

CastNexus can use a PC Streaming profile to relay an authorized Twitch live broadcast or rerun video content through the same destination fan-out used by OBS.

This feature is intended for content you own or are authorized to relay/rerun.

## Supported rerun inputs

- **Twitch live channel** — CastNexus resolves the current Twitch HLS/m3u8 media source at start time.
- **Twitch VOD / past broadcast URL**.
- **YouTube video / past livestream URL**.
- **Uploaded video file**.

## Profile isolation

The VOD library is scoped per CastNexus profile, just like profile music.

Uploaded files are stored under:

```text
dashboard/data/vod/<account-id>/<profile-id>/
```

or under the equivalent `vod/` directory inside the desktop `~/.castnexus` data directory.

A VOD item belonging to one profile is not returned through another profile's VOD API.

## Rerun-only video storage

Uploaded VOD files are deliberately separate from Overlay Studio media.

CastNexus does **not** expose profile VOD uploads as:

- Starting Soon backgrounds
- BRB backgrounds
- Ending backgrounds
- music-scene backgrounds
- custom overlay assets

They are video-program/rerun inputs only.

## Twitch live HLS / m3u8 relay

Open:

```text
CastNexus Studio → Reruns / VOD
```

Enter either:

```text
channelname
```

or:

```text
https://www.twitch.tv/channelname
```

Confirm that you own/have permission to relay the broadcast, then start the relay.

CastNexus resolves Twitch's live media source at start time and feeds FFmpeg into a dedicated internal MediaMTX path:

```text
relay/<castnexus-pc-key>
```

OBS remains on:

```text
live/<castnexus-pc-key>
```

The two publishers therefore never write to the same MediaMTX path.

Once the relay path becomes active, CastNexus uses the normal destination system:

```text
Twitch HLS/m3u8
      ↓
CastNexus relay/<pc-key>
      ↓
public/<login> / optional compositor
      ↓
Destinations
├── Twitch
├── YouTube
├── Kick
├── SRT
└── custom RTMP/RTMPS
```

If OBS is already the active source, the new relay is left as a standby source by CastNexus's existing sticky-source logic instead of taking over unexpectedly.

## Twitch VOD reruns

Add a Twitch past-broadcast URL such as:

```text
https://www.twitch.tv/videos/<vod-id>
```

CastNexus inspects the URL, stores its metadata in the active profile's VOD library, and resolves the current playable media URL again when you press **Play** or **Loop**.

The remote Twitch media is not permanently copied into the VOD upload folder unless you explicitly upload a local video yourself.

## YouTube VOD / past-livestream reruns

CastNexus uses **yt-dlp nightly** with **Deno** for YouTube extraction.

Docker release images include both tools. Windows/Linux desktop release bundles also include both tools beside the CastNexus executable.

The resolver enables Deno and yt-dlp's current EJS support, but CastNexus intentionally does **not** request/import browser cookies.

### Home/residential network note

YouTube often applies additional anti-automation challenges to hosting-provider, VPS and datacenter IP ranges. A normal home/residential connection is generally more reliable for URL resolving, but it is not a guarantee that every YouTube URL will work.

If YouTube responds with a challenge such as:

- sign in to confirm
- cookie/login required
- confirm you are not a bot
- a related 403 challenge

CastNexus returns an explanatory error and asks you to **upload the video manually** instead of asking for browser cookies.

This makes the failure mode predictable and avoids turning CastNexus into a browser-cookie collector.

## Manual video upload

Use **Upload video** on the Reruns / VOD page when:

- you already have the source file
- a YouTube URL is challenged on your network
- you want a stable local copy for repeated reruns

The default upload limit is controlled by:

```text
VOD_MAX_GB
```

Default:

```text
20 GB per uploaded file
```

FFmpeg must be available for playback. The Docker dashboard image includes FFmpeg. Desktop currently expects FFmpeg to be installed on the host PATH.

## Play vs Loop

- **Play** — run the VOD once, then finish.
- **Loop** — restart the VOD after it reaches the end.
- **Stop rerun / relay** — immediately stop the current generated source.

Twitch live relay is live-only and therefore does not have a loop mode.

## Output format

Twitch HLS/VOD inputs are normally already H.264/AAC, so CastNexus initially uses stream-copy into the internal relay where possible.

YouTube and uploaded-video reruns are normalized through FFmpeg to a streaming-safe H.264/AAC output before entering MediaMTX.

After that, each destination can still choose its existing CastNexus layout:

- Source / passthrough
- 16:9 Landscape
- 9:16 Vertical

A forced destination layout requires its normal additional FFmpeg encode.

## Starting Soon relative countdown

Overlay Studio also supports a relative Starting Soon timer.

Example:

```text
Countdown from now: 10 minutes
```

Every time **Starting Soon** is activated, CastNexus creates a new target exactly ten minutes from that activation time. The saved fixed date/time countdown remains available when the relative minute value is `0`.

This is useful for a workflow such as:

```text
10-minute Starting Soon
        ↓
Twitch/YouTube VOD rerun
        ↓
Ending
```

## Security / authorization

Remote Twitch/YouTube additions and Twitch-live relays require an explicit ownership/permission confirmation in Studio.

CastNexus URL validation only accepts supported Twitch/YouTube hosts for those resolver features. Arbitrary URLs are not passed to yt-dlp through these endpoints.
