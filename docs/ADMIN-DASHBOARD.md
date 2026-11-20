# Admin dashboard

**Studio → Admin** is the control page for the person who runs the CastNexus
server: the **host owner**. Nobody else sees it, and every `/api/admin/*`
request from another account is refused (`403 OWNER_ONLY`).

## Who is the host owner?

CastNexus picks the owner in this order:

1. `CASTNEXUS_OWNER_LOGIN=<twitch login>` in `.env`. Recommended when more than
   one person signs in.
2. Otherwise, the first name in `ALLOWED_TWITCH_LOGINS` that has signed in.
3. Otherwise, the **first Twitch account that ever signed in** to the install.

The Admin page shows how the owner was chosen, under *Sign-in & features*.

## What's on the page

| Section | What it shows / does |
| --- | --- |
| **Stats** | Number of accounts and blocked accounts, who is live now, host CPU and RAM, CastNexus version, channel and uptime. |
| **Sign-in & features** | Who can sign in: *open*, *closed* (`DISABLE_REGISTRATION`) or *allow-list* (`ALLOWED_TWITCH_LOGINS`). Also the host owner, the video encoder, and the feature switches (`CASTNEXUS_MUSIC24`, `CASTNEXUS_PC_STREAMING`, `CASTNEXUS_CONSOLE_STREAMING`, `CASTNEXUS_VOD`, `CASTNEXUS_DISCORD_ACTIVITY`). These are read-only, because they come from `.env`. |
| **Discord Activity** | Picks which **one** channel the Discord Activity plays. See the [Discord Activity guide](https://github.com/NekoSuneProjects/CastNexus/blob/docker/docs/DISCORD-ACTIVITY.md). |
| **Accounts** | Every account, searchable. For each: live state and source, active profile, stream key (imported from Twitch or entered manually), enabled outputs, when they joined, and last sign-in. |
| **Privacy Policy & Terms** | The public `/privacy` and `/terms` URLs, plus the operator name and contact shown on them. |
| **Admin log** | The last admin actions: who did what, to whom, and when. |

## Account actions

| Action | Effect |
| --- | --- |
| **Stop stream** | Stops routing the account's current broadcast to its destinations right away. The outputs stay off until that broadcast ends; the next one works normally. |
| **Sign out** | Ends the account's Studio sessions in every browser. They can sign in again. |
| **Block** | Signs them out, stops their stream from being routed and refuses sign-in until you **Unblock**. Their settings are kept. |
| **Remove** | Deletes the account from this install: profiles, destinations, scenes, stream key and settings. You must type their login to confirm. Uploaded files under `data/` stay on disk until you delete them. If registration is open they can sign in again as a new, empty account, so use **Block** to keep someone out. |

You can't block, sign out or remove the owner account from the Admin page, so
you can't lock yourself out. Every action is written to the admin log and to
the container log (`[admin] …`).

## Privacy Policy and Terms of Service

Every install serves:

| URL | Also reachable as |
| --- | --- |
| `https://<your domain>/privacy` | `/privacy-policy`, `/legal/privacy` |
| `https://<your domain>/terms` | `/terms-of-service`, `/tos`, `/legal/terms` |

Both pages include a **"This CastNexus installation"** section. It covers who
runs the server, what the install stores, the Discord Activity and console
stream key import, and how to ask for deletion. Fill in **Operator name**,
**Contact URL** and **Contact email** under *Privacy Policy & Terms* so that
section names you. You can also set defaults in `.env`:

```dotenv
CASTNEXUS_OPERATOR_NAME=NekoSuneVR
CASTNEXUS_CONTACT_URL=https://example.com/contact
CASTNEXUS_CONTACT_EMAIL=privacy@example.com
```

Values saved in the Admin page take priority over `.env`.

**Discord:** paste these two URLs into the Discord Developer Portal →
your application → **General Information** → *Privacy Policy URL* and *Terms of
Service URL*. Discord requires them before an Activity can be made public.

The pages are general templates, not legal advice. Check them against the laws
that apply to you before you rely on them.

## API reference

All routes require a signed-in Studio session belonging to the host owner.

| Method | Route | Body |
| --- | --- | --- |
| GET | `/api/admin/overview` | |
| GET | `/api/admin/users` | |
| POST | `/api/admin/users/:id/block` | `{ "blocked": true \| false }` |
| POST | `/api/admin/users/:id/sign-out` | |
| POST | `/api/admin/users/:id/stop` | |
| DELETE | `/api/admin/users/:id` | `{ "confirm": "<login>" }` |
| GET / PUT | `/api/admin/legal` | `{ "operatorName", "contactUrl", "contactEmail" }` |
| GET | `/api/admin/audit` | |
