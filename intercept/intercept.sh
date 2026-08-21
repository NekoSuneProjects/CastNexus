#!/usr/bin/env bash
set -euo pipefail

MODE="${INTERCEPT_MODE:-lan}"
IFACE="${IFACE:-eth0}"
DRY_RUN="${INTERCEPT_DRY_RUN:-false}"

log() { echo "[intercept] $*"; }
truthy() { [[ "${1,,}" == "1" || "${1,,}" == "true" || "${1,,}" == "yes" || "${1,,}" == "on" ]]; }

cleanup_chain() {
  local chain="${1:-CASTNEXUS_VPS_RTMP}"
  local port="${2:-1935}"
  while iptables -w -D INPUT -p tcp --dport "$port" -j "$chain" 2>/dev/null; do :; done
  iptables -w -F "$chain" 2>/dev/null || true
  iptables -w -X "$chain" 2>/dev/null || true
}

run_lan_mode() {
  local pi_ip="${PI_IP:?PI_IP required in LAN mode}"
  local gateway_ip="${GATEWAY_IP:?GATEWAY_IP required in LAN mode}"
  local target_ips="${TARGET_IPS:?TARGET_IPS required in LAN mode (comma or space separated)}"
  local targets=()
  IFS=', ' read -r -a targets <<< "$target_ips"

  log "LAN mode: routing [${targets[*]}] <-> $gateway_ip through $pi_ip on $IFACE"

  sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
  [[ "$(cat /proc/sys/net/ipv4/ip_forward)" == "1" ]] || {
    log "net.ipv4.ip_forward is not enabled on the host and this container can't set it — run: sudo sysctl -w net.ipv4.ip_forward=1"
    exit 1
  }

  local pids=()
  cleanup_lan() {
    log "stopping LAN intercept"
    for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  }
  trap cleanup_lan EXIT TERM INT

  for target_ip in "${targets[@]}"; do
    [[ -n "$target_ip" ]] || continue

    iptables -t nat -C PREROUTING -s "$target_ip" -p tcp --dport 1935 -j DNAT --to-destination "${pi_ip}:1935" 2>/dev/null \
      || iptables -t nat -A PREROUTING -s "$target_ip" -p tcp --dport 1935 -j DNAT --to-destination "${pi_ip}:1935"

    arpspoof -i "$IFACE" -t "$target_ip" "$gateway_ip" &
    pids+=("$!")
    arpspoof -i "$IFACE" -t "$gateway_ip" "$target_ip" &
    pids+=("$!")
    log "arpspoof running for $target_ip"
  done

  log "all LAN targets active (pids: ${pids[*]})"
  wait -n
}

run_vps_mode() {
  local port="${VPS_RTMP_PORT:-1935}"
  local allowed="${VPS_ALLOWED_CLIENTS:-}"
  local allow_any="${VPS_ALLOW_ANY:-false}"
  local wait_seconds="${VPS_RTMP_WAIT_SECONDS:-60}"
  local chain="CASTNEXUS_VPS_RTMP"
  local clients=()
  IFS=', ' read -r -a clients <<< "$allowed"

  if ! truthy "$allow_any" && [[ ${#clients[@]} -eq 0 ]]; then
    log "VPS mode refuses to expose RTMP without VPS_ALLOWED_CLIENTS. Set your home WAN IP/CIDR, or explicitly set VPS_ALLOW_ANY=true."
    exit 1
  fi

  log "VPS/public mode: console DNS should resolve Twitch ingest to this server; no ARP spoofing or gateway IP is used"
  if truthy "$allow_any"; then
    log "VPS/public mode: TCP/$port ACL = ANY CLIENT (VPS_ALLOW_ANY=true)"
    log "VPS/public mode: warning: public RTMP is unrestricted; use VPS_ALLOWED_CLIENTS for a home WAN IP/CIDR when possible"
  else
    log "VPS/public mode: TCP/$port ACL = ${allowed}"
  fi

  if truthy "$DRY_RUN"; then
    log "dry-run validation passed"
    return 0
  fi

  cleanup_vps() {
    log "stopping VPS/public intercept"
    cleanup_chain "$chain" "$port"
  }
  trap cleanup_vps EXIT TERM INT

  cleanup_chain "$chain" "$port"
  iptables -w -N "$chain"
  iptables -w -A "$chain" -s 127.0.0.0/8 -j ACCEPT

  if truthy "$allow_any"; then
    iptables -w -A "$chain" -j ACCEPT
  else
    local count=0
    for client in "${clients[@]}"; do
      [[ -n "$client" ]] || continue
      iptables -w -A "$chain" -s "$client" -j ACCEPT
      count=$((count + 1))
      log "VPS RTMP allow $client"
    done
    [[ "$count" -gt 0 ]] || { log "no valid VPS_ALLOWED_CLIENTS entries were provided"; exit 1; }
    iptables -w -A "$chain" -j DROP
  fi

  iptables -w -I INPUT 1 -p tcp --dport "$port" -j "$chain"

  local ready=0
  for _ in $(seq 1 "$wait_seconds"); do
    if ss -ltnH | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    log "TCP/$port is not listening after ${wait_seconds}s; MediaMTX/public RTMP is not ready"
    exit 1
  fi

  log "VPS/public console RTMP gateway active on TCP/$port"
  log "plain RTMP only: RTMPS/TLS cannot be transparently impersonated with DNS redirection"
  while true; do sleep 3600; done
}

case "${MODE,,}" in
  lan|local) run_lan_mode ;;
  vps|public) run_vps_mode ;;
  *) log "unknown INTERCEPT_MODE=$MODE (expected lan or vps)"; exit 1 ;;
esac
