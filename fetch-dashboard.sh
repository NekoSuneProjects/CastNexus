#!/usr/bin/env bash
# Fetches the dashboard app (from the dashboard branch of this repo) into
# ./dashboard so electron-builder can bundle it via `extraFiles`, and so
# `npm run dev`/`start` has something to require in-process.
set -euo pipefail

REPO_URL="${CASTNEXUS_REPO_URL:-https://github.com/NekoSuneProjects/CastNexus}"
TMP_DIR=".dashboard-branch-fetch"

rm -rf "$TMP_DIR" dashboard
git clone --depth 1 --branch dashboard "$REPO_URL" "$TMP_DIR"
cp -r "$TMP_DIR/dashboard" dashboard
rm -rf "$TMP_DIR"

echo "Fetched dashboard/ from the dashboard branch."

# node_modules is gitignored, so the fetched copy has none. Without this the
# packaged app fails at startup with "Cannot find module 'express'".
echo "Installing dashboard/ dependencies..."
npm --prefix dashboard install --omit=dev
