#!/usr/bin/env bash
# Fetches the CastNexus dashboard app (the dashboard branch of this repo) into
# ./build/dashboard, so the image can be built locally from source:
#
#   ./fetch-dashboard.sh
#   docker compose -f docker-compose.yml -f docker-compose.build.yml build dashboard
#   docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
#
# Not needed for a normal install: docker-compose.yml pulls the published
# ghcr.io image. ./build is separate from ./dashboard/data (your live data),
# which this script never touches.
#
# Options (environment):
#   CASTNEXUS_REPO_URL   repository to clone (default: the official repo)
#   CASTNEXUS_BRANCH     branch to fetch (default: dashboard)
set -euo pipefail
cd "$(dirname "$0")"

REPO_URL="${CASTNEXUS_REPO_URL:-https://github.com/NekoSuneProjects/CastNexus}"
BRANCH="${CASTNEXUS_BRANCH:-dashboard}"
TMP_DIR=".dashboard-branch-fetch"

rm -rf "$TMP_DIR" build/dashboard
mkdir -p build
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TMP_DIR"
cp -r "$TMP_DIR/dashboard" build/dashboard
REVISION="$(git -C "$TMP_DIR" rev-parse HEAD)"
rm -rf "$TMP_DIR"
echo "$REVISION" > build/dashboard.revision

echo "Fetched dashboard/ from the $BRANCH branch ($REVISION) into build/dashboard."
echo "Build it with:"
echo "  docker compose -f docker-compose.yml -f docker-compose.build.yml build dashboard"
