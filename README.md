# CastNexus oauth-broker

A small standalone OAuth2 broker service for Twitch and YouTube/Google, used by
CastNexus installations (Docker, Desktop, CLI) so they never need to hold
Twitch or Google application client secrets themselves.

Client applications complete a one-time PKCE transaction against this
service; provider client secrets remain only on the broker.

See [`docs/HOSTED-OAUTH.md`](docs/HOSTED-OAUTH.md) for the full design, API
surface and security properties.

## Running it

```bash
cp .env.example .env
# fill in OAUTH_BROKER_SIGNING_SECRET, TWITCH_CLIENT_ID/SECRET,
# YOUTUBE_CLIENT_ID/SECRET, and your public URL
docker compose up -d
```

## Development

```bash
cd oauth-broker
npm install
npm test
```
