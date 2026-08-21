# Cover artwork fallback and Raspberry Pi RTMP stability

## Music cover priority

CastNexus resolves artwork in this order:

1. Embedded artwork inside the uploaded audio file.
2. No-key metadata/cover services.
   - MusicBrainz metadata + Cover Art Archive artwork.
   - Apple iTunes Search API artwork fallback.
3. The profile's configured **Cover / Logo URL**.
4. CastNexus' built-in music-note placeholder.

External artwork is not hot-linked forever. When a provider finds a match, CastNexus downloads the image, normalizes it to JPEG with FFmpeg and stores it beside that profile's audio file. That means the radio overlay keeps working if a provider is temporarily unavailable later.

New uploads also read `title`, `artist` and `album` tags with ffprobe before doing the external lookup. Editing track metadata invalidates a previously cached external cover and triggers a fresh lookup. Embedded artwork always wins and is never replaced by an online result.

### Provider configuration

```dotenv
COVER_LOOKUP_PROVIDERS=musicbrainz,itunes
COVER_LOOKUP_TIMEOUT_MS=5000
COVER_LOOKUP_CACHE_HOURS=168
COVER_REMOTE_MAX_MB=10
COVER_MUSICBRAINZ_USER_AGENT=CastNexus/1.0 (https://github.com/NekoSuneProjects/CastNexus)
COVER_ITUNES_COUNTRY=US
```

MusicBrainz requires a meaningful User-Agent and asks clients not to exceed roughly one request per second. CastNexus serializes MusicBrainz calls with a delay and caches results.

No API key is required for the configured providers, but **no-key does not mean public-domain artwork**. Album artwork remains owned by its rights holder. Apple's Search API documentation also places usage conditions on promotional content such as album art. Operators who do not want the Apple provider can use:

```dotenv
COVER_LOOKUP_PROVIDERS=musicbrainz
```

## Why YouTube could report 0-2 kbps audio

The old `source` destination path stream-copied both video and audio. That is cheap on a Raspberry Pi, but if the upstream AAC stream became sparse, silent or timestamp-broken, YouTube saw the same bad audio packets. The old Music 24/7 compositor could also wait on an empty music FIFO while no track was active, which could stall the mixed output.

The new pipeline keeps video copy-light where possible but always normalizes live destination audio to:

- AAC
- 128 kbps
- stereo
- 48 kHz
- asynchronous audio timestamp correction

The compositor also keeps its music input alive with generated PCM silence whenever no song is playing. This prevents the audio mixer from blocking the video output during standby or track changes.

## Raspberry Pi / ARM safe mode

`CASTNEXUS_PI_SAFE_MODE=auto` is enabled by default behavior. When CastNexus is running on ARM and no usable hardware H.264 encoder was detected, expensive generated/transcoded 1080p canvases are reduced to 720p:

- 1920x1080 -> 1280x720
- 1080x1920 -> 720x1280
- maximum 30 FPS
- x264 `ultrafast` CPU preset
- default 720p target around 4 Mbps

Normal source passthrough still copies the incoming video instead of needlessly re-encoding it, so a good 1080p OBS feed can remain 1080p while CastNexus only re-encodes its audio to a stable 128 kbps AAC stream.

If the ARM host has a working hardware encoder, CastNexus keeps the requested 1080p canvas. To force 1080p on CPU-only ARM anyway:

```dotenv
CASTNEXUS_PI_SAFE_MODE=false
```

## Useful RTMP settings

```dotenv
RTMP_INPUT_QUEUE=1024
DESTINATION_AUDIO_BITRATE=128k
DESTINATION_AUDIO_RATE=48000
```

Optional live-transcode tuning:

```dotenv
DESTINATION_VIDEO_BITRATE=6000k
DESTINATION_VIDEO_MAXRATE=6000k
DESTINATION_VIDEO_BUFSIZE=12000k
DESTINATION_X264_PRESET=veryfast

COMPOSITOR_AUDIO_BITRATE=128k
COMPOSITOR_VIDEO_BITRATE=6000k
COMPOSITOR_VIDEO_MAXRATE=6000k
COMPOSITOR_VIDEO_BUFSIZE=12000k
COMPOSITOR_X264_PRESET=veryfast
```

For CPU-only Raspberry Pi systems, leave the x264 preset unset so CastNexus can automatically select `ultrafast`.

YouTube Live currently recommends H.264/RTMP(S), a two-second keyframe interval, CBR video and 128 kbps stereo audio. CastNexus' transcoded H.264 path already uses a two-second GOP; this change specifically makes the audio target deterministic and reduces ARM encode load so FFmpeg is more likely to remain realtime instead of starving YouTube of video frames.
