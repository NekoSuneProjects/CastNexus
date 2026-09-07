#!/usr/bin/env bash
# Fetches service source folders from their own branches, so `docker compose
# build` can build local images instead of pulling the prebuilt ones from
# ghcr.io. Not needed for a normal install - docker-compose.yml already
# references the published images by default.
#
# Usage:
#   ./fetch-sources.sh                # required services: dashboard dns intercept
#   ./fetch-sources.sh vrchat-relay    # + the optional VRChat relay add-on
#   ./fetch-sources.sh oauth-broker    # + a self-hosted oauth-broker
#   ./fetch-sources.sh relaystream     # + a self-hosted public relay
set -euo pipefail

REPO_URL="${CASTNEXUS_REPO_URL:-https://github.com/NekoSuneProjects/CastNexus}"
SERVICES=(dashboard dns intercept "$@")

for service in "${SERVICES[@]}"; do
  tmp_dir=".${service}-branch-fetch"
  rm -rf "$tmp_dir" "./$service"
  git clone --depth 1 --branch "$service" "$REPO_URL" "$tmp_dir"
  cp -r "$tmp_dir/$service" "./$service"
  rm -rf "$tmp_dir"
  echo "Fetched $service/ from the $service branch."
done
