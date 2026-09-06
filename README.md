# CastNexus CLI

A headless install/launch CLI for the CastNexus dashboard - for servers and
terminal workflows that don't want to manage the Docker stack directly.

The dashboard app itself lives in the `dashboard` branch of this repository,
not here - this branch only holds the launcher (`cli/`). Fetch it before
running or building:

```bash
npm run fetch:dashboard   # clones dashboard/ from the dashboard branch
npm run install:all
npm start                 # or: npm run setup / npm run build
```

See [`cli/README.md`](cli/README.md) for the launcher's own usage details.

Sign-in (Twitch, and optionally YouTube) goes through the CastNexus
oauth-broker service from a browser at the dashboard URL - there are no
developer credentials to configure in the CLI.
