#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is not installed."
  echo "Beginner setup: docs/BEGINNER-SETUP.md"
  exit 1
}

docker compose version >/dev/null 2>&1 || {
  echo "Docker Compose v2 is not available."
  echo "Install the Docker Compose plugin, then run this script again."
  echo "Beginner setup: docs/BEGINNER-SETUP.md"
  exit 1
}

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env. Edit PI_IP, then run ./install.sh again."
  echo "For normal PC / OBS / Music use, leave TARGET_IPS and GATEWAY_IP blank."
  exit 0
fi

env_var() { awk -F= "/^$1=/{print \$2}" .env | tr -d '\r'; }

PI_IP="$(env_var PI_IP)"
[[ -n "$PI_IP" ]] || { echo "PI_IP is missing"; exit 1; }

DASHBOARD_PORT="$(env_var DASHBOARD_PORT)"
DASHBOARD_PORT="${DASHBOARD_PORT:-8090}"
TARGET_IPS="$(env_var TARGET_IPS)"
GATEWAY_IP="$(env_var GATEWAY_IP)"
IMAGE_TAG="$(env_var CASTNEXUS_IMAGE_TAG)"
CHANNEL="$(env_var CASTNEXUS_CHANNEL)"
IMAGE_TAG="${IMAGE_TAG:-latest}"
CHANNEL="${CHANNEL:-stable}"

export CASTNEXUS_IMAGE_TAG="$IMAGE_TAG"
export CASTNEXUS_CHANNEL="$CHANNEL"

echo "CastNexus channel: $CHANNEL (Docker tag: $IMAGE_TAG)"

# --- GPU detection ---------------------------------------------------------
# Give the container the host GPU when there is one, so CastNexus can use
# NVENC / VAAPI / Quick Sync. Without a GPU nothing is added and CastNexus
# encodes with CPU x264, sized to this machine by its hardware test.
# The choice is written to COMPOSE_FILE in .env, so later plain
# `docker compose ...` commands use the same files.
set_env_var() {
  if grep -q "^$1=" .env; then
    sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
  else
    printf '\n%s=%s\n' "$1" "$2" >> .env
  fi
}

GPU_MODE="$(env_var CASTNEXUS_GPU)"
GPU_MODE="${GPU_MODE:-auto}"
GPU_FOUND="none"
case "$GPU_MODE" in
  auto|nvidia)
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
      if docker info 2>/dev/null | grep -qi 'runtimes:.*nvidia'; then
        GPU_FOUND="nvidia"
      else
        echo "NVIDIA GPU found, but the NVIDIA Container Toolkit is not set up for Docker."
        echo "  Install it to use NVENC: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
      fi
    fi
    ;;
esac
if [[ "$GPU_FOUND" == "none" && ( "$GPU_MODE" == "auto" || "$GPU_MODE" == "vaapi" ) ]]; then
  compgen -G "/dev/dri/renderD*" >/dev/null && GPU_FOUND="vaapi"
fi
[[ "$GPU_MODE" =~ ^(auto|nvidia|vaapi|none|cpu)$ ]] || echo "Unknown CASTNEXUS_GPU=$GPU_MODE (use auto, nvidia, vaapi or none); treating as auto."

COMPOSE_FILES="docker-compose.yml"
case "$GPU_FOUND" in
  nvidia) COMPOSE_FILES="$COMPOSE_FILES:docker-compose.gpu-nvidia.yml"; echo "GPU: NVIDIA (NVENC) - CastNexus tests it and falls back to CPU if it fails." ;;
  vaapi)  COMPOSE_FILES="$COMPOSE_FILES:docker-compose.gpu-vaapi.yml";  echo "GPU: /dev/dri (Intel/AMD VAAPI / Quick Sync) - CastNexus tests it and falls back to CPU if it fails." ;;
  *)      echo "GPU: none passed to Docker - CPU x264 encoding, auto-sized to this CPU." ;;
esac

# Keep a hand-written COMPOSE_FILE (anything beyond our own files) untouched.
CURRENT_COMPOSE="$(env_var COMPOSE_FILE)"
if [[ -z "$CURRENT_COMPOSE" || "$CURRENT_COMPOSE" =~ ^docker-compose\.yml(:docker-compose\.gpu-(nvidia|vaapi)\.yml)?$ ]]; then
  set_env_var COMPOSE_FILE "$COMPOSE_FILES"
  export COMPOSE_FILE="$COMPOSE_FILES"
else
  echo "Keeping custom COMPOSE_FILE from .env: $CURRENT_COMPOSE"
  export COMPOSE_FILE="$CURRENT_COMPOSE"
fi

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
echo "Studio: http://$PI_IP:$DASHBOARD_PORT"
echo "Profiles: PC Streaming / Console Streaming / Music 24/7"
echo

if [[ "$CONSOLE_CAPTURE" == "1" ]]; then
  echo "Console DNS + intercept active for: $TARGET_IPS"
  echo "  Console Primary DNS:   $PI_IP"
  echo "  Console Secondary DNS: 0.0.0.0 or leave blank if supported"
  echo
  echo "DNS:       docker compose logs -f dns"
  echo "Intercept: docker compose logs -f intercept"
fi

echo "MediaMTX:  docker compose logs -f mediamtx"
echo "Studio / Music 24/7: docker compose logs -f dashboard"
