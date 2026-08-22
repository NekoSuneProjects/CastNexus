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
