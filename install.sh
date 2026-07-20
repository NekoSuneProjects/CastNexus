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

# Whether to capture a physical console (dns hijack + ARP-spoof intercept) is
# an infrastructure-level decision made here, not a per-account one - if
# you've filled in TARGET_IPS, you have a console to capture. Which source(s)
# each dashboard account actually uses (console / PC streaming software /
# both) is chosen per-account in the dashboard itself after logging in.
TARGET_IPS="$(env_var TARGET_IPS)"
GATEWAY_IP="$(env_var GATEWAY_IP)"

if [[ -n "$TARGET_IPS" ]]; then
  [[ -n "$GATEWAY_IP" ]] || { echo "TARGET_IPS is set but GATEWAY_IP is missing"; exit 1; }
  docker compose --profile console up -d --build --force-recreate
  CONSOLE_CAPTURE=1
else
  # No console to capture - only mediamtx + dashboard start. OBS/streaming
  # software can still push straight to mediamtx regardless.
  docker compose up -d --build --force-recreate
  CONSOLE_CAPTURE=0
fi

echo
echo "NekoSune Restream Node is running."
echo
echo "Dashboard: http://$PI_IP:8090 - sign in and pick console / PC / both per account."
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
echo "Dashboard: docker compose logs -f dashboard"
