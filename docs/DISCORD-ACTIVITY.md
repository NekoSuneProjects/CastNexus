# Discord Activity: watch CastNexus inside a Discord voice channel

The CastNexus Discord Activity lets everyone in a Discord voice channel watch a
CastNexus stream together. It shows up under the channel's **Activities** (🚀)
button. Nobody has to screen-share. This helps when the person streaming is on a
**PS5 / Xbox / Switch**, because a console can't share its screen to Discord.
Without the Activity, someone would have to capture the console on a Windows PC
and screen-share from there.

```text
PS5 ──RTMP──> CastNexus VPS (console gateway) ──> Twitch / YouTube / ...
                     │
                     └──> public/<login> ──> Discord Activity (WebRTC or LL-HLS)
                                              in any voice channel
```

Any CastNexus source works: **console**, **PC / OBS**, **Music 24/7** or a
**VOD rerun**. The Activity plays the same `public/<login>` program as the
other playback links, so scenes and overlays baked in by the compositor show up
in Discord too.

## Requirements

- CastNexus reachable on a **public HTTPS domain**, for example
  `https://castnexus.example.com` behind your reverse proxy. Discord will not
  load plain HTTP or a raw IP address.
- A Discord application. Creating one is free.
- Optional, for the lowest latency: MediaMTX WebRTC UDP (`8189/udp`) reachable
  from viewers, with `webrtcAdditionalHosts` set in `config/mediamtx.yml`. When
  WebRTC can't connect, the Activity falls back to LL-HLS over HTTPS
  automatically.

## 1. Create the Discord application

1. Open <https://discord.com/developers/applications> and select **New Application**.
2. Copy the **Application ID** from **General Information**. This is
   `DISCORD_CLIENT_ID`. It is public and not a secret. CastNexus does not need
   the client secret or a bot token.
3. Open **Activities → Settings** and turn on **Enable Activities**.
4. Open **Activities → URL Mappings** and set the root mapping:

   | Prefix | Target |
   | --- | --- |
   | `/` | `castnexus.example.com/activity` |

   Use your own domain, without `https://`. One mapping is enough, because
   everything the Activity needs is served under `/activity` on CastNexus.
5. Open **Installation**, enable **Guild Install**, and use the install link to add
   the app to your Discord server. You can also enable **User Install** if you
   want to launch it anywhere.

While the application is still in development, Discord may limit who can
launch it, for example to members of the app's team or its testers. See
Discord's Activities documentation for how to open it to everyone.

## 2. Configure CastNexus (`.env`)

```dotenv
CASTNEXUS_DISCORD_ACTIVITY=true
DISCORD_CLIENT_ID=123456789012345678

# Optional
DISCORD_ACTIVITY_CHANNELS=           # blank = whoever is live right now; or: login1,login2
DISCORD_ACTIVITY_DEFAULT_CHANNEL=    # open this channel immediately, e.g. nekosunevr
DISCORD_ACTIVITY_TITLE=CastNexus Live
DISCORD_ACTIVITY_WEBRTC=true         # false = always use LL-HLS
```

Restart the stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile vps-console up -d
```

The dashboard log should show
`[discord-activity] watch page enabled at /activity`.

To check the page before trying it in Discord, open
`https://castnexus.example.com/activity/` in a normal browser. Opened outside
Discord, the page works the same way but skips the Discord handshake.

## 3. Use it

1. Start streaming as usual. For a PS5 on the VPS console gateway, see
   [VPS-CONSOLE-GATEWAY.md](VPS-CONSOLE-GATEWAY.md).
2. In Discord, join a voice channel, select the **Activities** (🚀) button and
   choose your app.
3. Pick the live stream, or it opens directly if `DISCORD_ACTIVITY_DEFAULT_CHANNEL`
   is set or only one channel is listed.
4. Everyone starts muted because of browser autoplay rules. Tap **Tap to unmute**.

The stream list refreshes every few seconds. If the streamer goes offline, the
player waits and reconnects when they come back.

## Who can be watched

- With `DISCORD_ACTIVITY_CHANNELS` blank, the Activity lists only channels on
  this install that are **live right now**. Offline accounts are never
  advertised.
- With `DISCORD_ACTIVITY_CHANNELS=login1,login2`, it lists exactly those Twitch
  logins, including while they are offline, and hides everyone else.
- The Activity's stream proxy (`/activity/hls`, `/activity/webrtc`) only serves
  `public/<login>` programs of the channels above. Ingest paths and stream keys
  are never reachable through it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Activity shows "DISCORD_CLIENT_ID is not set" | Set `DISCORD_CLIENT_ID` to the numeric Application ID and restart. |
| Activity stays blank or shows a Discord error | Check that the URL mapping target is `your-domain/activity` and that `https://your-domain/activity/` opens in a browser. |
| "Nobody is live right now" | The source must be live in CastNexus, and allowed by its feature switch (`CASTNEXUS_CONSOLE_STREAMING` etc.). |
| Video takes 2-5 s to start, or lags slightly | That's LL-HLS. Open `8189/udp` and set `webrtcAdditionalHosts` for WebRTC. |
| No sound | Tap **Tap to unmute**. Every viewer starts muted. |
