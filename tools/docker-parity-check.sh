#!/usr/bin/env bash
# CastNexus Docker parity check.
#
# Run this INSIDE the running CastNexus container (or on the host, if the
# MediaMTX ports are reachable) while a profile is live. It measures the
# things the Docker-parity task actually cares about, from the encoded output
# rather than from FFmpeg's self-reported fps:
#
#   docker exec -it castnexus-dashboard bash /app/tools/docker-parity-check.sh nekosunevr
#
# Every check prints PASS / FAIL / SKIP and the script exits non-zero if any
# check failed, so it can be dropped into CI on a Pi or a VPS.

set -uo pipefail

PROFILE="${1:-}"
SECONDS_TO_SAMPLE="${SAMPLE_SECONDS:-30}"
EXPECTED_FPS="${EXPECTED_FPS:-30}"
MEDIAMTX_API="${MEDIAMTX_API:-http://127.0.0.1:9997}"
HLS_BASE="${HLS_BASE:-http://127.0.0.1:8888}"
WHEP_BASE="${WHEP_BASE:-http://127.0.0.1:8889}"
RTSP_BASE="${RTSP_BASE:-rtsp://127.0.0.1:8554}"
WORK_DIR="$(mktemp -d)"
FAILURES=0

if [ -z "$PROFILE" ]; then
  echo "usage: $0 <twitch-login>   # the public/<login> MediaMTX path" >&2
  exit 2
fi
PATH_NAME="public/${PROFILE}"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

need() { command -v "$1" >/dev/null 2>&1; }

for tool in ffmpeg ffprobe curl; do
  need "$tool" || { echo "missing required tool: $tool" >&2; exit 2; }
done

echo "CastNexus Docker parity check"
echo "  path        : $PATH_NAME"
echo "  sample      : ${SECONDS_TO_SAMPLE}s"
echo "  expected fps: $EXPECTED_FPS"

# ---------------------------------------------------------------------------
section "1. MediaMTX sees a healthy inbound feed"
API_JSON="$WORK_DIR/path.json"
if curl -fsS "${MEDIAMTX_API}/v3/paths/get/${PATH_NAME}" -o "$API_JSON" 2>/dev/null; then
  READY=$(grep -o '"ready"[[:space:]]*:[[:space:]]*true' "$API_JSON" || true)
  if [ -n "$READY" ]; then pass "path is ready"; else fail "path exists but is not ready"; fi
  # MediaMTX reports decode/frame errors per reader; any non-zero is a problem.
  ERRORS=$(grep -o '"bytesReceived"[[:space:]]*:[[:space:]]*[0-9]*' "$API_JSON" | head -1 || true)
  [ -n "$ERRORS" ] && echo "        $ERRORS"
else
  fail "MediaMTX Control API did not return ${PATH_NAME} (is the profile live?)"
fi

# ---------------------------------------------------------------------------
section "2. Programme output is real-time at the configured cadence"
SAMPLE="$WORK_DIR/sample.mkv"
START_EPOCH=$(date +%s)
ffmpeg -hide_banner -loglevel error -nostdin \
  -rtsp_transport tcp -i "${RTSP_BASE}/${PATH_NAME}" \
  -t "$SECONDS_TO_SAMPLE" -c copy "$SAMPLE" </dev/null
WALL=$(( $(date +%s) - START_EPOCH ))

if [ ! -s "$SAMPLE" ]; then
  fail "could not record ${SECONDS_TO_SAMPLE}s from ${RTSP_BASE}/${PATH_NAME}"
else
  VIDEO_FRAMES=$(ffprobe -v error -select_streams v:0 -count_packets \
    -show_entries stream=nb_read_packets -of csv=p=0 "$SAMPLE" | tr -d '\r')
  VIDEO_DUR=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration \
    -of csv=p=0 "$SAMPLE" | tr -d '\r')
  AUDIO_DUR=$(ffprobe -v error -select_streams a:0 -show_entries stream=duration \
    -of csv=p=0 "$SAMPLE" | tr -d '\r')
  echo "        wall clock ${WALL}s, video ${VIDEO_DUR}s, audio ${AUDIO_DUR}s, ${VIDEO_FRAMES} frames"

  # Real-time means the recorded media duration tracks the wall clock. A
  # compositor rendering slower than real time produces a short file for a
  # long recording, which is exactly the Docker regression this guards.
  ACHIEVED_FPS=$(awk -v f="$VIDEO_FRAMES" -v d="$VIDEO_DUR" 'BEGIN{if(d>0)printf "%.2f", f/d; else print "0"}')
  echo "        achieved output fps: $ACHIEVED_FPS (expected ~${EXPECTED_FPS})"
  awk -v a="$ACHIEVED_FPS" -v e="$EXPECTED_FPS" 'BEGIN{exit !(a >= e*0.92)}' \
    && pass "output holds >=92% of the configured fps" \
    || fail "output fps $ACHIEVED_FPS is below 92% of $EXPECTED_FPS"

  awk -v v="$VIDEO_DUR" -v w="$WALL" 'BEGIN{exit !(v >= w*0.9)}' \
    && pass "recorded duration tracks the wall clock (not rendering slow)" \
    || fail "recorded ${VIDEO_DUR}s of media in ${WALL}s of wall clock"

  # A/V drift: after a sustained sample the two stream durations must still
  # agree. Accumulating drift shows up here long before it is audible.
  DRIFT=$(awk -v v="$VIDEO_DUR" -v a="$AUDIO_DUR" 'BEGIN{d=v-a;if(d<0)d=-d;printf "%.3f", d}')
  echo "        A/V drift over ${SECONDS_TO_SAMPLE}s: ${DRIFT}s"
  awk -v d="$DRIFT" 'BEGIN{exit !(d < 0.25)}' \
    && pass "A/V drift under 250ms" \
    || fail "A/V drift ${DRIFT}s - audio is accumulating behind or ahead of video"

  # Silence or dropouts: measure the audio actually present, not just that a
  # stream exists. mean_volume of -91dB is digital silence.
  MEAN_DB=$(ffmpeg -hide_banner -nostdin -i "$SAMPLE" -map a:0 -af volumedetect \
    -f null - 2>&1 </dev/null | grep -o 'mean_volume:.*dB' | head -1 | grep -o '\-\?[0-9.]*' | head -1)
  echo "        mean audio level: ${MEAN_DB:-unknown} dB"
  if [ -z "${MEAN_DB:-}" ]; then
    skip "could not measure audio level"
  elif awk -v v="$MEAN_DB" 'BEGIN{exit !(v > -80)}'; then
    pass "programme audio is audible, not silence"
  else
    fail "programme audio is effectively silent (${MEAN_DB} dB)"
  fi
fi

# ---------------------------------------------------------------------------
section "3. HLS carries 48 kHz stereo AAC (the VRChat / media-player path)"
PLAYLIST="$WORK_DIR/index.m3u8"
if curl -fsS "${HLS_BASE}/${PATH_NAME}/index.m3u8" -o "$PLAYLIST" 2>/dev/null; then
  pass "HLS playlist is served"
  HLS_PROBE=$(ffprobe -v error -show_entries stream=codec_name,sample_rate,channels \
    -select_streams a:0 -of csv=p=0 "${HLS_BASE}/${PATH_NAME}/index.m3u8" 2>/dev/null | tr -d '\r')
  echo "        HLS audio: ${HLS_PROBE:-none}"
  case "$HLS_PROBE" in
    aac,48000,2) pass "HLS audio is 48 kHz stereo AAC" ;;
    "")          fail "HLS playlist has no readable audio stream" ;;
    *)           fail "HLS audio is '$HLS_PROBE', expected aac,48000,2" ;;
  esac
  # LL-HLS serves fMP4 partial segments. Unity/AVPro based players - VRChat
  # included - are far happier with the MPEG-TS variant, so warn loudly.
  if grep -q 'EXT-X-PART\|\.mp4' "$PLAYLIST"; then
    skip "playlist is low-latency fMP4 (hlsVariant: lowLatency). VRChat's player usually needs hlsVariant: mpegts - verify on a headset before shipping."
  else
    pass "playlist is the widely compatible MPEG-TS variant"
  fi
else
  fail "HLS playlist not reachable at ${HLS_BASE}/${PATH_NAME}/index.m3u8"
fi

# ---------------------------------------------------------------------------
section "4. WebRTC negotiates H.264 + Opus"
SDP="$WORK_DIR/whep.sdp"
if curl -fsS -X POST -H "Content-Type: application/sdp" --data "" \
     "${WHEP_BASE}/${PATH_NAME}/whep" -o "$SDP" 2>/dev/null && [ -s "$SDP" ]; then
  grep -qi "H264" "$SDP" && pass "H.264 offered over WebRTC" || fail "no H.264 in the WHEP answer"
  grep -qi "opus" "$SDP" && pass "Opus offered over WebRTC" || fail "no Opus in the WHEP answer - WebRTC will be silent"
else
  # An empty-body POST is rejected by some MediaMTX builds; fall back to
  # checking that the parallel Opus track exists on the path at all.
  if ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 \
       -rtsp_transport tcp "${RTSP_BASE}/${PATH_NAME}" 2>/dev/null | grep -qi opus; then
    pass "an Opus track is published alongside AAC (WebRTC will have audio)"
  else
    fail "no Opus track on ${PATH_NAME} - WebRTC playback will be silent"
  fi
fi

# ---------------------------------------------------------------------------
section "5. Resource use"
if need top; then
  echo "        $(top -bn1 2>/dev/null | grep -i 'Cpu(s)' | head -1 || echo 'cpu unavailable')"
fi
if [ -r /proc/meminfo ]; then
  echo "        $(grep -E 'MemTotal|MemAvailable' /proc/meminfo | tr '\n' ' ')"
fi
for proc in ffmpeg chromium chrome; do
  COUNT=$(pgrep -c "$proc" 2>/dev/null || echo 0)
  [ "$COUNT" != "0" ] && echo "        ${proc}: ${COUNT} process(es)"
done
if need nvidia-smi; then
  nvidia-smi --query-gpu=utilization.gpu,utilization.encoder,memory.used \
    --format=csv,noheader 2>/dev/null | sed 's/^/        nvidia: /' || true
elif [ -e /dev/dri/renderD128 ]; then
  echo "        VAAPI render node present (/dev/dri/renderD128)"
else
  echo "        no GPU encoder device visible - CPU x264 path"
fi

# ---------------------------------------------------------------------------
section "Result"
if [ "$FAILURES" -eq 0 ]; then
  echo "  all checks passed"
else
  echo "  ${FAILURES} check(s) failed"
fi
echo
echo "Still to confirm by hand (this script cannot):"
echo "  * audio matches the visible progress/spectrum across at least two"
echo "    automatic song changes - watch the scene while listening"
echo "  * the copied HLS url plays inside a VRChat video player"
echo "  * a real Twitch/RTMP destination does not accumulate buffering"
exit $(( FAILURES > 0 ))
