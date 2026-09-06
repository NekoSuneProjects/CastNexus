# CastNexus desktop app

A native Electron control room for Windows and Linux, running the same
CastNexus dashboard/streaming engine embedded in-process.

The dashboard app itself lives in the `dashboard` branch of this repository,
not here - this branch only holds the Electron wrapper (`electron/`). Fetch
it before running or building:

```bash
npm run fetch:dashboard   # clones dashboard/ from the dashboard branch
npm run install:all
npm run dev               # or: npm run build
```

Sign-in (Twitch, and optionally YouTube) goes through the CastNexus
oauth-broker service, the same as every other CastNexus install - there are
no developer credentials to configure in the desktop setup wizard.
