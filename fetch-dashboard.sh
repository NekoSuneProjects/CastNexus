#!/usr/bin/env bash
# Fetches the dashboard app (from the dashboard branch of this repo) into
# ./dashboard so the CLI launcher can require it in-process, and so `pkg`
# can bundle it into the standalone binary via cli/package.json's pkg config.
set -euo pipefail

REPO_URL="${CASTNEXUS_REPO_URL:-https://github.com/NekoSuneProjects/CastNexus}"
TMP_DIR=".dashboard-branch-fetch"

rm -rf "$TMP_DIR" dashboard
git clone --depth 1 --branch dashboard "$REPO_URL" "$TMP_DIR"
cp -r "$TMP_DIR/dashboard" dashboard
rm -rf "$TMP_DIR"

echo "Fetched dashboard/ from the dashboard branch."
