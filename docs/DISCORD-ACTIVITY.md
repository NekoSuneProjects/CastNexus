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
                     └──> public/<your login> ──> Discord Activity (HLS over HTTPS)
                                                   in any voice channel
```

- **Plays the right person automatically.** In **Auto** mode (the default
  once `DISCORD_CLIENT_SECRET` is set), the Activity looks at who is in the
  voice channel and plays whoever has **linked their Discord account** in
  CastNexus and is **live** right now. If nobody is, it shows the host owner's
  chosen channel. **Fixed** mode always plays that one channel.
- **No browsing other people.** The Activity never lists the install's
  accounts. It only ever shows people who are in the voice channel, linked and
  opted in, or the owner's channel.
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
5. [Auto-detect: link Discord accounts](#5-auto-detect-link-discord-accounts)
6. [Watch in Discord](#6-watch-in-discord)
7. [Console-only setup example](#7-console-only-setup-example-ps5--vps)
8. [Security and privacy](#8-security-and-privacy)
9. [Reference](#9-reference)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Requirements

| Need | Why |
| --- | --- |
| CastNexus on a **public HTTPS domain**, e.g. `https://castnexus.example.com` behind a reverse proxy | Discord only loads Activities over HTTPS from a real domain. A raw IP or plain HTTP won't work. |
| A Discord application (free) | Discord runs the Activity under your application. |
| `CASTNEXUS_CONSOLE_STREAMING=true` (default) | Needed for the PS5 / console source. |
| Nothing extra for video | The Activity plays **HLS only**, over HTTPS through Discord's proxy, so no UDP ports or WebRTC setup are needed (latency is about 2-6 s). |

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
5. On **General Information**, set:
   - **Privacy Policy URL**: `https://castnexus.example.com/privacy`
   - **Terms of Service URL**: `https://castnexus.example.com/terms`

   Every install serves both pages. Studio → **Admin → Privacy Policy & Terms**
   shows the exact URLs and lets you add your operator name and contact. See the
   [Admin dashboard guide](https://github.com/NekoSuneProjects/CastNexus/blob/dashboard/docs/ADMIN-DASHBOARD.md).
6. For **auto-detect** (recommended), open **OAuth2**:
   - Copy the **Client Secret**. This is `DISCORD_CLIENT_SECRET`. Keep it
     private: it goes only in `.env` on the server.
   - Under **Redirects**, add `https://castnexus.example.com/auth/discord/callback`.
     Studio → Settings → Discord Activity shows the exact URL.
7. Open **Installation**.
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
DISCORD_CLIENT_SECRET=...             # enables auto-detect + "Link Discord" (keep private)

# Optional
CASTNEXUS_OWNER_LOGIN=nekosunevr      # who controls the Activity (default: first sign-in)
DISCORD_REDIRECT_URI=                 # only if the auto-built https://<domain>/auth/discord/callback is wrong
DISCORD_ACTIVITY_CHANNEL=             # lock the channel here instead of choosing it in Studio
DISCORD_ACTIVITY_TITLE=CastNexus Live
```

Apply it:

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile vps-console up -d
```

The dashboard log should show
`[discord-activity] watch page enabled at /activity (auto-detects live linked streamers in the voice channel, else the owner's channel)`.
Without `DISCORD_CLIENT_SECRET`, the log says *channel chosen by the host owner
in Settings*, and the Activity works in Fixed mode only.

## 4. Choose the channel (host owner)

The **host owner** has full control over install-wide settings. CastNexus picks
the owner in this order:

1. `CASTNEXUS_OWNER_LOGIN` in `.env`. Recommended if more than one person signs
   in to your install. If that login has never signed in, there is no owner
   until it does.
2. Otherwise, the first name in `ALLOWED_TWITCH_LOGINS` that has signed in.
3. Otherwise, the **first Twitch account that ever signed in** to this install.

To choose what it plays:

1. Sign in to CastNexus Studio as the owner.
2. Open **Settings → Discord Activity** (also on the **Admin** page).
3. **What the Activity plays**:
   - **Auto**: live, linked streamers in the voice channel. This is the
     default when `DISCORD_CLIENT_SECRET` is set.
   - **Fixed**: always the channel below.
4. **Fallback / fixed channel**: pick a Twitch channel. The default is your
   own. Auto mode shows this channel when nobody in the voice channel is live.
   - Only Twitch accounts that have signed in to this CastNexus are offered.
   - There is no free-text field, so the Activity can never play a random
     Twitch channel.
5. Click **Save**.
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

## 5. Auto-detect: link Discord accounts

Twitch and Discord accounts aren't connected, so each streamer links theirs
**once**:

1. Sign in to CastNexus Studio with your Twitch account.
2. **Settings → Your Discord account → Link Discord**.
3. Approve on Discord. CastNexus asks only for `identify` (your user ID,
   username and avatar). It keeps your Discord ID with your CastNexus account
   and revokes the access token straight away.
4. Leave **Show me in the Discord Activity when I'm live** on. Switch it off any
   time to stay hidden, or **Unlink**.

Rules:
- One Discord account links to one CastNexus account. Linking it somewhere
  else moves it.
- The **Admin** accounts list shows who has linked Discord, and who is hidden.

What happens in a voice channel:

1. A viewer opens the Activity. The first time, Discord asks them once to
   allow **identify** and **guilds**. With `guilds`, the Activity can see who
   is in the current voice channel.
2. The Activity sends the voice channel's member IDs to CastNexus. CastNexus
   answers with the members who are **linked + opted in + live**.
3. It updates every 6 seconds:
   - **One person live:** it plays straight away.
   - **Several live:** switcher chips appear in the player bar.
   - **Nobody live:** it shows the owner's fallback channel, with *"Nobody in
     this voice channel is live on CastNexus right now"*.
4. If a viewer declines the Discord prompt, their Activity behaves like Fixed
   mode.

The streamer doesn't need to open the Activity themselves; they only need to
be **in the voice channel**. This also works for a PS5 player who joined voice
from the Discord app on their phone or console.

## 6. Watch in Discord

1. Start streaming as usual. For a PS5 on the VPS gateway, see
   [VPS-CONSOLE-GATEWAY.md](VPS-CONSOLE-GATEWAY.md) and the
   [stream key guide](CONSOLE-STREAM-KEY.md).
2. In Discord, join a voice channel, select **Activities** (🚀) and pick your app.
3. The stream opens straight away: the live streamer in this voice channel
   (Auto), or the owner's channel.
   - **Offline:** viewers see the channel's name and avatar, and *"is offline
     right now"*. Playback starts on its own when the stream goes live.
   - **Drops:** if the stream drops, the Activity reconnects automatically.
4. Everyone starts **muted**, because browsers block autoplay with sound. Tap
   **Tap to unmute**.

## 7. Console-only setup example (PS5 + VPS)

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

# Discord Activity (auto-detects you in the voice channel once you link Discord)
CASTNEXUS_DISCORD_ACTIVITY=true
DISCORD_CLIENT_ID=123456789012345678
DISCORD_CLIENT_SECRET=...
```

With these settings:
- **Kept:** Console profiles, console scenes, overlays and scene music (Starting
  Soon / BRB / background music). These work as normal.
- **Gone:** the Music 24/7 radio and PC/OBS options disappear from the Studio,
  and any PC/OBS or radio stream that arrives is ignored.

## 8. Security and privacy

- **No account list.** `/activity/api/channel` returns only the owner's
  channel. `/activity/api/voice-live` answers only for the Discord IDs it's
  given, and only with accounts that are **linked, opted in, not blocked and
  live**. Nothing else about the install's accounts is exposed.
- **Viewer must be real.** `voice-live` requires the viewer's own Discord
  access token. CastNexus checks it with Discord, caching the result for about
  5 minutes, and never stores it.
- **Proxy is limited.** The Activity's stream proxy (`/activity/hls`,
  `/activity/tshls`) serves only:
  - `public/<owner's channel>`, and
  - in Auto mode, `public/<login>` of linked, opted-in accounts that are live
    right now.

  Ingest paths (`app/...`, `live/...`) and stream keys always return `404`.
- **Secret stays server-side.** `DISCORD_CLIENT_SECRET` never reaches the
  browser. Code exchange happens on the server.
- **Avatars come from your server.** They are fetched only from Twitch's
  image CDN (`static-cdn.jtvnw.net`), because Discord's sandbox blocks outside
  images.
- **Viewers don't sign in to CastNexus.** In Fixed mode the Activity requests
  no Discord scopes. In Auto mode it requests `identify` + `guilds`, and never
  messages, voice or video.
- **Only the owner can change it.** Changing the channel requires a signed-in
  Studio session belonging to the host owner. Each change is logged as
  `[discord-activity] <login> set the Activity channel to <channel>`.

## 9. Reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `CASTNEXUS_DISCORD_ACTIVITY` | `false` | Turns the Activity page (`/activity`) on. |
| `DISCORD_CLIENT_ID` | — | Discord Application ID (numbers only). |
| `DISCORD_CLIENT_SECRET` | — | Discord OAuth2 client secret. Enables Auto mode and "Link Discord". Server-side only. |
| `DISCORD_REDIRECT_URI` | `https://<domain>/auth/discord/callback` | Override the Link Discord callback URL. Must match the Discord portal. |
| `CASTNEXUS_OWNER_LOGIN` | first sign-in | Twitch login of the host owner. |
| `DISCORD_ACTIVITY_CHANNEL` | — | Locks the played channel. Leave blank to let the owner choose in Studio. |
| `DISCORD_ACTIVITY_TITLE` | `CastNexus Live` | Page title. |

| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /activity/` | public | The Activity page |
| `GET /activity/api/channel` | public | The owner's channel and its live state |
| `POST /activity/api/token` `{ "code" }` | Activity | Exchanges the SDK authorize code (Auto mode) |
| `POST /activity/api/voice-live` `{ "userIds": [...] }` + `Authorization: Bearer <discord token>` | Activity | Live, linked, opted-in streamers among those Discord users |
| `GET /activity/api/avatar/<login>` | public | Avatar served through your server |
| `GET /auth/discord` → `/auth/discord/callback` | signed in | Link your Discord account |
| `GET /api/discord/link`, `POST /api/discord/unlink`, `POST /api/discord/visibility` `{ "visible" }` | signed in | Your Discord link |
| `GET /api/discord-activity` | signed in | Status; the owner also gets the list of accounts to choose from |
| `POST /api/discord-activity` `{ "channel": "<login>", "mode": "auto" \| "fixed" }` | host owner | Choose the mode and the fallback / fixed channel (`""` = owner's own) |

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| *"DISCORD_CLIENT_ID is not set"* | Set it to the numeric Application ID and restart. |
| *"No channel is set up for this Activity yet"* | Nobody has signed in yet, or `CASTNEXUS_OWNER_LOGIN` / `DISCORD_ACTIVITY_CHANNEL` names a login that hasn't signed in. Sign in once with that Twitch account. |
| Activity is blank or shows a Discord error | The URL-mapping target must be `your-domain/activity`. Check that `https://your-domain/activity/` opens in a browser. |
| Shows offline while you are live | The selected channel must be the CastNexus account receiving the stream. Check Settings → Discord Activity. For consoles, the account needs its Twitch stream key ([CONSOLE-STREAM-KEY.md](CONSOLE-STREAM-KEY.md)). |
| Settings card says only the owner can change it | You aren't the host owner. Set `CASTNEXUS_OWNER_LOGIN` to your login, or sign in as the owner. |
| 2-6 s delay | Normal for HLS. The Activity is HLS-only, because WebRTC can't get through Discord's sandbox. |
| No sound | Tap **Tap to unmute**. Every viewer starts muted. |
| Auto mode doesn't find me | Link Discord in Settings, and keep *Show me in the Discord Activity* on. You must be live on CastNexus and **in that voice channel** with the Discord account you linked. |
| "Link Discord" fails / Discord says *Invalid OAuth2 redirect_uri* | Add the exact URL from Settings → Discord Activity under OAuth2 → Redirects in the Discord portal. Set `DISCORD_REDIRECT_URI` if your public domain differs. |
| Avatars are broken | Update CastNexus. Avatars are now served by your server, because Discord blocks outside images. |
| Stuck on *Reconnecting…* | Run `docker logs castnexus-dashboard \| grep "discord-activity] viewer"`. The Activity reports which transport it used, or why each one failed, and also shows the reason under the spinner. It tries **low-latency HLS → classic HLS** (the VRChat remuxer on `:8898`) **→ the browser's native HLS player**. It counts a method as working only once the video is actually moving, demotes any method that stalls for 12 s, and shows the method in use in the player bar (e.g. *LIVE · Console · HLS*). |
| Works in a browser but not in Discord | Check the `viewer:` lines in `docker logs`. Classic HLS needs the `castnexus-mediamtx-vrchat` container running (it is in the default compose file). The native-HLS fallback avoids `blob:` URLs entirely, for Discord clients with a strict sandbox. |
