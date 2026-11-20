# Discord Activity: watch your PS5 stream inside Discord

The CastNexus Discord Activity lets everyone in a Discord voice channel watch
your stream together. They open it from the voice channel's **Activities** (🚀)
button. Nobody has to share their screen.

This matters for console players. A **PS5 / Xbox / Switch can't screen-share to
Discord**, so the usual workaround is a capture card and a Windows PC. With
CastNexus, the console streams to your server as normal and Discord plays that
stream directly.

```text
PS5 ──RTMP──> CastNexus (VPS console gateway) ──> Twitch / YouTube / ...
                     │
                     └──> public/<your login> ──> Discord Activity (WebRTC or LL-HLS)
                                                   in any voice channel
```

- **One channel only.** The Activity never lists, browses or plays anyone
  else's stream. It plays exactly one CastNexus channel, chosen by the host
  owner.
- **Any source.** Console, PC/OBS, Music 24/7 and VOD reruns all work. The
  Activity plays the same `public/<login>` program as your other playback
  links, so overlays and scenes baked in by the compositor show up in Discord
  too.

---

## Contents

1. [Requirements](#1-requirements)
2. [Create the Discord application](#2-create-the-discord-application)
3. [Configure CastNexus](#3-configure-castnexus-env)
4. [Choose the channel (host owner)](#4-choose-the-channel-host-owner)
5. [Watch in Discord](#5-watch-in-discord)
6. [Console-only setup example](#6-console-only-setup-example-ps5--vps)
7. [Security and privacy](#7-security-and-privacy)
8. [Reference](#8-reference)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Requirements

| Need | Why |
| --- | --- |
| CastNexus on a **public HTTPS domain**, e.g. `https://castnexus.example.com` behind a reverse proxy | Discord only loads Activities over HTTPS from a real domain. A raw IP or plain HTTP won't work. |
| A Discord application (free) | Discord runs the Activity under your application. |
| `CASTNEXUS_CONSOLE_STREAMING=true` (default) | Needed for the PS5 / console source. |
| Optional: MediaMTX WebRTC UDP `8189/udp` open, plus `webrtcAdditionalHosts` in `config/mediamtx.yml` | Lowest latency (under 1 s). Without it the Activity falls back to LL-HLS over HTTPS automatically (about 2-5 s). |

## 2. Create the Discord application

1. Open <https://discord.com/developers/applications> and select **New Application**.
   Name it what you want viewers to see, for example *NekoSune Live*.
2. On **General Information**, copy the **Application ID**. This is
   `DISCORD_CLIENT_ID`.
   - It is public, not a secret.
   - CastNexus does **not** need the client secret or a bot token.
3. Open **Activities → Settings** and turn on **Enable Activities**.
4. Open **Activities → URL Mappings** and set the root mapping:

   | Prefix | Target |
   | --- | --- |
   | `/` | `castnexus.example.com/activity` |

   - Use your own domain, without `https://`.
   - Studio → Settings → Discord Activity shows the exact target to copy.
   - One mapping is enough, because everything the Activity needs is served
     under `/activity`.
5. Open **Installation**.
   - Enable **Guild Install** and use the install link to add the app to your
     Discord server.
   - Optionally, enable **User Install** so you can launch it anywhere.

While the app is in development, Discord may limit who can launch it, for
example to members of the app's team or its App Testers. See Discord's
Activities documentation when you want to open it to everyone.

## 3. Configure CastNexus (`.env`)

```dotenv
CASTNEXUS_DISCORD_ACTIVITY=true
DISCORD_CLIENT_ID=123456789012345678

# Optional
CASTNEXUS_OWNER_LOGIN=nekosunevr      # who controls the Activity (default: first sign-in)
DISCORD_ACTIVITY_CHANNEL=             # lock the channel here instead of choosing it in Studio
DISCORD_ACTIVITY_TITLE=CastNexus Live
DISCORD_ACTIVITY_WEBRTC=true          # false = always use LL-HLS
```

Apply it:

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile vps-console up -d
```

The dashboard log should show
`[discord-activity] watch page enabled at /activity (channel chosen by the host owner in Settings)`.

## 4. Choose the channel (host owner)

The **host owner** has full control over install-wide settings. CastNexus picks
the owner in this order:

1. `CASTNEXUS_OWNER_LOGIN` in `.env`. Recommended if more than one person signs
   in to your install. If that login has never signed in, there is no owner
   until it does.
2. Otherwise, the first name in `ALLOWED_TWITCH_LOGINS` that has signed in.
3. Otherwise, the **first Twitch account that ever signed in** to this install.

To choose the channel:

1. Sign in to CastNexus Studio as the owner.
2. Open **Settings → Discord Activity**.
3. Under **Channel the Activity plays**, pick the Twitch channel. The default
   is your own.
   - Only Twitch accounts that have signed in to this CastNexus are offered.
   - There is no free-text field, so the Activity can never play a random
     Twitch channel.
4. Click **Save**.
   - Anyone already watching switches over within a few seconds. They don't
     need to restart the Activity.

The card also shows:
- whether the channel is **LIVE** or **OFFLINE**, and its source (Console / PC / Music / Rerun)
- the URL-mapping target to paste into the Discord Developer Portal
- **Open the Activity page**, to test it in a normal browser first

Other accounts can see what the Activity plays but **can't change it**. The API
refuses them (`403 OWNER_ONLY`).

To lock the channel so nobody can change it in Studio, set
`DISCORD_ACTIVITY_CHANNEL=<twitch login>` in `.env` and restart. The Settings
card then shows *Locked by DISCORD_ACTIVITY_CHANNEL*.

## 5. Watch in Discord

1. Start streaming as usual. For a PS5 on the VPS gateway, see
   [VPS-CONSOLE-GATEWAY.md](VPS-CONSOLE-GATEWAY.md) and the
   [stream key guide](CONSOLE-STREAM-KEY.md).
2. In Discord, join a voice channel, select **Activities** (🚀) and pick your app.
3. The stream opens straight away. There is no list to choose from.
   - **Offline:** viewers see the channel's name and avatar, and *"is offline
     right now"*. Playback starts on its own when the stream goes live.
   - **Drops:** if the stream drops, the Activity reconnects automatically.
4. Everyone starts **muted**, because browsers block autoplay with sound. Tap
   **Tap to unmute**.

## 6. Console-only setup example (PS5 + VPS)

A VPS that only relays a PS5, with background music on console scenes, plus
the Discord Activity:

```dotenv
# Console only: no Music 24/7 radio, no PC/OBS ingest
CASTNEXUS_MUSIC24=false
CASTNEXUS_PC_STREAMING=false
CASTNEXUS_CONSOLE_STREAMING=true

# Only you can sign in, and you are the owner
ALLOWED_TWITCH_LOGINS=nekosunevr
CASTNEXUS_OWNER_LOGIN=nekosunevr

# VPS console gateway (see VPS-CONSOLE-GATEWAY.md)
PUBLIC_IP=203.0.113.55
VPS_ALLOWED_CLIENTS=198.51.100.27/32

# Discord Activity
CASTNEXUS_DISCORD_ACTIVITY=true
DISCORD_CLIENT_ID=123456789012345678
```

With these settings:
- **Kept:** Console profiles, console scenes, overlays and scene music (Starting
  Soon / BRB / background music). These work as normal.
- **Gone:** the Music 24/7 radio and PC/OBS options disappear from the Studio,
  and any PC/OBS or radio stream that arrives is ignored.

## 7. Security and privacy

- **One channel.** `/activity/api/channel` returns only the selected channel:
  login, display name, avatar, and whether it is live. Nothing about other
  accounts on the install is exposed.
- **Proxy is limited.** The Activity's stream proxy (`/activity/hls`,
  `/activity/webrtc`) serves only `public/<selected login>`.
  - Other channels, ingest paths (`app/...`, `live/...`) and stream keys return `404`.
  - When the owner switches channels, the previous channel stops being reachable
    through the Activity immediately.
- **No login needed for viewers.** Viewers don't sign in to CastNexus, and the
  Activity doesn't request any Discord OAuth scopes. It only performs the
  Embedded App SDK handshake.
- **Only the owner can change it.** Changing the channel requires a signed-in
  Studio session belonging to the host owner. Each change is logged as
  `[discord-activity] <login> set the Activity channel to <channel>`.

## 8. Reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `CASTNEXUS_DISCORD_ACTIVITY` | `false` | Turns the Activity page (`/activity`) on. |
| `DISCORD_CLIENT_ID` | — | Discord Application ID (numbers only). |
| `CASTNEXUS_OWNER_LOGIN` | first sign-in | Twitch login of the host owner. |
| `DISCORD_ACTIVITY_CHANNEL` | — | Locks the played channel. Leave blank to let the owner choose in Studio. |
| `DISCORD_ACTIVITY_TITLE` | `CastNexus Live` | Page title. |
| `DISCORD_ACTIVITY_WEBRTC` | `true` | Try WebRTC first; `false` = LL-HLS only. |

| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /activity/` | public | The Activity page |
| `GET /activity/api/channel` | public | The selected channel and its live state |
| `GET /api/discord-activity` | signed in | Status; the owner also gets the list of accounts to choose from |
| `POST /api/discord-activity` `{ "channel": "<login>" }` | host owner | Choose the channel (`""` = owner's own) |

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| *"DISCORD_CLIENT_ID is not set"* | Set it to the numeric Application ID and restart. |
| *"No channel is set up for this Activity yet"* | Nobody has signed in yet, or `CASTNEXUS_OWNER_LOGIN` / `DISCORD_ACTIVITY_CHANNEL` names a login that hasn't signed in. Sign in once with that Twitch account. |
| Activity is blank or shows a Discord error | The URL-mapping target must be `your-domain/activity`. Check that `https://your-domain/activity/` opens in a browser. |
| Shows offline while you are live | The selected channel must be the CastNexus account receiving the stream. Check Settings → Discord Activity. For consoles, the account needs its Twitch stream key ([CONSOLE-STREAM-KEY.md](CONSOLE-STREAM-KEY.md)). |
| Settings card says only the owner can change it | You aren't the host owner. Set `CASTNEXUS_OWNER_LOGIN` to your login, or sign in as the owner. |
| 2-5 s delay | That's LL-HLS. Open `8189/udp` and set `webrtcAdditionalHosts` for WebRTC. |
| No sound | Tap **Tap to unmute**. Every viewer starts muted. |
