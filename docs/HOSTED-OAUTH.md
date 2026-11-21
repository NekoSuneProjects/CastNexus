# Hosted OAuth broker

CastNexus installations use the public broker at:

```text
https://castnexus.nekosunevr.co.uk/oauth
```

The broker owns the Twitch and Google OAuth client secrets. Docker, Desktop
and CLI installations create a short-lived transaction and an S256 PKCE pair,
open the provider in the user's browser, then poll the broker with the secret
verifier. Provider callbacks always return to the fixed public broker. The
broker never accepts a caller-provided callback URL.

## Public deployment

Generate a signing secret and keep it only on the broker host:

```bash
openssl rand -base64 48
```

Set the result as `OAUTH_BROKER_SIGNING_SECRET`, configure the provider
credentials, then start:

```bash
docker compose -f docker-compose.oauth-broker.yml up -d
```

Configure the existing HTTPS reverse proxy so the public `/oauth` location
forwards to `http://127.0.0.1:8091`. The broker accepts both preserved and
stripped `/oauth` prefixes. For example, Nginx can strip it with a trailing
slash on `proxy_pass`:

```nginx
location /oauth/ {
    proxy_pass http://127.0.0.1:8091/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_connect_timeout 10s;
    proxy_read_timeout 30s;
    client_max_body_size 32k;
}
```

Register these exact provider callbacks:

```text
https://castnexus.nekosunevr.co.uk/oauth/callback/twitch
https://castnexus.nekosunevr.co.uk/oauth/callback/youtube
```

Verify deployment with:

```text
https://castnexus.nekosunevr.co.uk/oauth/health
```

Public CastNexus application pages are served by the main dashboard, not the
OAuth broker:

```text
Homepage:       https://castnexus.nekosunevr.co.uk/
Login:          https://castnexus.nekosunevr.co.uk/login
Studio:         https://castnexus.nekosunevr.co.uk/dashboard
Privacy policy: https://castnexus.nekosunevr.co.uk/privacy
Terms:          https://castnexus.nekosunevr.co.uk/terms
```

Use the homepage, privacy-policy and terms URLs in the Google OAuth consent
screen and other provider application settings. `/oauth/` remains a narrowly
scoped global authentication proxy for CastNexus installations. Review the policy text and
ensure the stated operator identity, contact route, infrastructure log
retention and operational practices match the production deployment.

## Security properties

- Provider secrets exist only on the public broker.
- Transactions expire after ten minutes and are single-use.
- S256 PKCE protects transaction exchange.
- OAuth state is signed and compared in constant time.
- The broker has no arbitrary redirect or remote-fetch parameter.
- Responses disable caching, framing and MIME sniffing.
- Sensitive endpoints are rate limited by proxy-derived client IP.
- Request bodies are limited to 16 KiB.
- Provider tokens are never placed in browser URLs.
- Twitch login returns identity only.
- Twitch stream key import (`purpose: "stream_key"` on `POST /v1/transactions`)
  is a separate, explicit authorization. It asks Twitch for
  `channel:read:stream_key` with `force_verify`, so the user always sees the
  consent screen. The broker reads the key once (`GET helix/streams/key`) and
  revokes the user token immediately. It returns only `{ purpose, user,
  streamKey }`: no Twitch token and no broker sign-in token. The CastNexus
  install then refuses the key unless `user.id` matches the signed-in account.
  Unknown purposes, and any purpose on YouTube, are rejected with `400`. No
  change to the Twitch application is needed.
- YouTube refresh tokens are returned once to the user's own server, encrypted
  there using the existing CastNexus state secret, and sent back to the broker
  only when a short-lived YouTube access token is required.

The current transaction store is intentionally in memory. Run one broker
replica during beta. A multi-replica deployment must replace it with a shared
TTL store such as Redis before scaling horizontally.

## Local-credential fallback

For Docker, set `CASTNEXUS_OAUTH_BROKER_URL` to an empty value. For Desktop or
CLI, set `CASTNEXUS_OAUTH_MODE=local`. Then configure the existing
Twitch/YouTube client ID, secret and callback variables to restore the local
bring-your-own-credentials flow.

## Stream title / game (Twitch and Kick)

CastNexus can set the stream title and game/category on Twitch and Kick from
**Settings -> Stream info**. Each platform is connected separately with its own
consent screen:

- **Twitch** uses the purpose `channel_manage` (scope `channel:manage:broadcast`).
- **Kick** is an OAuth 2.1 + PKCE provider (scopes `user:read channel:read channel:write`).
  Create an app at <https://kick.com/settings/developer>, set its redirect URI to
  `<OAUTH_BROKER_PUBLIC_URL>/callback/kick`, then set `KICK_CLIENT_ID` and
  `KICK_CLIENT_SECRET` on the broker. Without them Kick is simply unavailable.

As with YouTube, the broker stores nothing: the user's access and refresh
tokens are returned once to that user's CastNexus install, which refreshes them
through `POST /v1/twitch/refresh` and `POST /v1/kick/refresh` (these only add the
client secret; they never see or keep anything else).

