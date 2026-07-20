#!/usr/bin/env bash
set -euo pipefail

IFACE="${IFACE:-eth0}"
PI_IP="${PI_IP:?PI_IP required}"
GATEWAY_IP="${GATEWAY_IP:?GATEWAY_IP required}"
# comma or space separated list of console IPs to intercept, e.g. PS5+Xbox
TARGET_IPS="${TARGET_IPS:?TARGET_IPS required (comma or space separated)}"

IFS=', ' read -r -a TARGETS <<< "$TARGET_IPS"

echo "[intercept] routing [${TARGETS[*]}] <-> $GATEWAY_IP through $PI_IP on $IFACE"

sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
[[ "$(cat /proc/sys/net/ipv4/ip_forward)" == "1" ]] || {
  echo "[intercept] net.ipv4.ip_forward is not enabled on the host and this container can't set it — run: sudo sysctl -w net.ipv4.ip_forward=1"
  exit 1
}

PIDS=()
cleanup() {
  echo "[intercept] stopping"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT TERM INT

for TARGET_IP in "${TARGETS[@]}"; do
  [[ -n "$TARGET_IP" ]] || continue

  # Any RTMP connection this console opens, no matter what IP it thinks
  # it's dialing, lands on our own relay instead.
  iptables -t nat -C PREROUTING -s "$TARGET_IP" -p tcp --dport 1935 -j DNAT --to-destination "${PI_IP}:1935" 2>/dev/null \
    || iptables -t nat -A PREROUTING -s "$TARGET_IP" -p tcp --dport 1935 -j DNAT --to-destination "${PI_IP}:1935"

  arpspoof -i "$IFACE" -t "$TARGET_IP" "$GATEWAY_IP" &
  PIDS+=("$!")
  arpspoof -i "$IFACE" -t "$GATEWAY_IP" "$TARGET_IP" &
  PIDS+=("$!")

  echo "[intercept] arpspoof running for $TARGET_IP"
done

echo "[intercept] all targets active (pids: ${PIDS[*]})"
wait -n
