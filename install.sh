#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is not installed."
  exit 1
}

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env. Edit it, then run ./install.sh again."
  exit 0
fi

env_var() { awk -F= "/^$1=/{print \$2}" .env | tr -d '\r'; }

PI_IP="$(env_var PI_IP)"
[[ -n "$PI_IP" ]] || { echo "PI_IP is missing"; exit 1; }

TARGET_IPS="$(env_var TARGET_IPS)"
GATEWAY_IP="$(env_var GATEWAY_IP)"
IMAGE_TAG="$(env_var CASTNEXUS_IMAGE_TAG)"
CHANNEL="$(env_var CASTNEXUS_CHANNEL)"
IMAGE_TAG="${IMAGE_TAG:-latest}"
CHANNEL="${CHANNEL:-stable}"

export CASTNEXUS_IMAGE_TAG="$IMAGE_TAG"
export CASTNEXUS_CHANNEL="$CHANNEL"

echo "CastNexus channel: $CHANNEL (Docker tag: $IMAGE_TAG)"

if [[ -n "$TARGET_IPS" ]]; then
  [[ -n "$GATEWAY_IP" ]] || { echo "TARGET_IPS is set but GATEWAY_IP is missing"; exit 1; }
  docker compose --profile console pull
  docker compose --profile console up -d --force-recreate
  CONSOLE_CAPTURE=1
else
  docker compose pull
  docker compose up -d --force-recreate
  CONSOLE_CAPTURE=0
fi

echo
echo "CastNexus is running."
echo
echo "Studio: http://$PI_IP:8090"
echo "Profiles: PC Streaming / Console Streaming / Music 24/7"
echo

if [[ "$CONSOLE_CAPTURE" == "1" ]]; then
  echo "Console DNS hijack + intercept active for: $TARGET_IPS"
  echo "  Console Primary DNS:   $PI_IP"
  echo "  Console Secondary DNS: 0.0.0.0"
  echo
  echo "DNS:       docker compose logs -f dns"
  echo "Intercept: docker compose logs -f intercept"
fi

echo "MediaMTX:  docker compose logs -f mediamtx"
echo "Studio:    docker compose logs -f dashboard"
echo "Music 24/7: docker compose logs -f music24"
