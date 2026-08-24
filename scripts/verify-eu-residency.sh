#!/usr/bin/env bash
#
# Verify that transcription really runs on EU infrastructure.
#
# Sends a tiny generated WAV (one second of a 440Hz tone — no patient data) to
# both the EU and global endpoints and reports what happens.
#
# How to read the result:
#   EU 200        -> account is EU-provisioned. Done.
#   EU 400        -> key ACCEPTED, audio rejected. Auth works, so EU is fine.
#   EU 401 / 403  -> key REJECTED at the EU endpoint. The account is NOT
#                    provisioned for EU processing — contact the vendor.
#
# USAGE
#   DEEPGRAM_API_KEY=xxxx ./scripts/verify-eu-residency.sh
#
# The key is never printed and never leaves this machine except to the vendor.
set -uo pipefail

EU_HOST="api.eu.deepgram.com"
GLOBAL_HOST="api.deepgram.com"
TMP_WAV="$(mktemp -t dgtest).wav"
trap 'rm -f "$TMP_WAV"' EXIT

command -v python3 >/dev/null || { echo "python3 required"; exit 1; }

# --- 1. Where do the hostnames actually resolve? ---------------------------
echo "============================================================"
echo " 1. DNS — where does each endpoint live?"
echo "============================================================"
for host in "$EU_HOST" "$GLOBAL_HOST"; do
  echo
  echo "  $host"
  resolved="$(dig +short "$host" 2>/dev/null | head -5)"
  if [ -z "$resolved" ]; then
    echo "    (could not resolve)"
  else
    echo "$resolved" | sed 's/^/    /'
    # AWS ELB hostnames embed the region, e.g. ...eu-central-1.elb.amazonaws.com
    region="$(echo "$resolved" | grep -oE '[a-z]{2}-[a-z]+-[0-9]' | head -1)"
    [ -n "$region" ] && echo "    --> region: $region"
  fi
done

# --- 2. Generate a harmless test tone --------------------------------------
python3 - "$TMP_WAV" <<'PY'
import math, struct, sys, wave

path = sys.argv[1]
rate, secs, freq = 16000, 1.0, 440.0
frames = bytearray()
for i in range(int(rate * secs)):
    v = int(32767 * 0.3 * math.sin(2 * math.pi * freq * (i / rate)))
    frames += struct.pack("<h", v)

with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(bytes(frames))
PY
echo
echo "  Test audio: $(wc -c < "$TMP_WAV") bytes (440Hz tone, no patient data)"

case "${DEEPGRAM_API_KEY:-}" in
  ""|"..."|"xxxx"|"paste-key-here"|"your-key-here")
    echo
    echo "!! DEEPGRAM_API_KEY looks like a placeholder, not a real key:"
    echo "!!   '${DEEPGRAM_API_KEY:-<empty>}'"
    echo "!! Substitute the actual key from Supabase -> Edge Functions -> Secrets."
    exit 1 ;;
esac

if [ -z "${DEEPGRAM_API_KEY:-}" ]; then
  echo
  echo "!! DEEPGRAM_API_KEY not set — skipping the live API check."
  echo "!! Re-run as:  DEEPGRAM_API_KEY=xxxx $0"
  exit 0
fi

# --- 3. Hit both endpoints -------------------------------------------------
echo
echo "============================================================"
echo " 2. Live API check"
echo "============================================================"

# $3 = "eu" | "global" — the two endpoints have OPPOSITE success criteria.
# For EU we want the key accepted. For Global, a rejection is GOOD: it proves
# the key is region-scoped and cannot send audio to the US even by mistake.
check() {
  local host="$1" label="$2" kind="${3:-eu}"
  local out status time_total
  out="$(curl -s -w '\n__STATUS__%{http_code}\n__TIME__%{time_total}\n' \
      --max-time 30 \
      -X POST "https://${host}/v1/listen?model=nova-2-medical&language=en-GB" \
      -H "Authorization: Token ${DEEPGRAM_API_KEY}" \
      -H "Content-Type: audio/wav" \
      --data-binary "@${TMP_WAV}" 2>&1)"

  status="$(printf '%s' "$out" | sed -n 's/^__STATUS__//p')"
  [ "$kind" = "eu" ] && EU_STATUS="$status"
  time_total="$(printf '%s' "$out" | sed -n 's/^__TIME__//p')"

  echo
  echo "  ${label}  (${host})"
  echo "    HTTP ${status:-error}   ${time_total:+${time_total}s}"

  if [ "$kind" = "eu" ]; then
    case "$status" in
      200) echo "    PASS - key accepted, EU endpoint working" ;;
      400) echo "    PASS - key accepted (test audio rejected, which is fine)" ;;
      401|403) echo "    FAIL - key REJECTED at the EU endpoint."
               echo "           Account is NOT provisioned for EU processing." ;;
      *)   echo "    ?    - unexpected; body below"
           printf '%s' "$out" | grep -v '^__' | head -3 | sed 's/^/      /' ;;
    esac
  else
    case "$status" in
      401|403)
        if [ "${EU_STATUS:-}" = "200" ] || [ "${EU_STATUS:-}" = "400" ]; then
          # EU accepted it, US did not -> genuinely region-scoped.
          echo "    GOOD - key rejected by the US endpoint."
          echo "           The key is region-scoped: audio CANNOT reach the US."
        else
          # Rejected everywhere -> the key itself is the problem.
          echo "    n/a  - also rejected here. Combined with the EU result this"
          echo "           means the KEY IS INVALID, not that it is region-scoped."
        fi ;;
      200|400) echo "    NOTE - key also works against the US endpoint."
               echo "           Not a fault (the app no longer calls it), but the key"
               echo "           is not region-locked, so a misconfiguration could route"
               echo "           audio to the US. Ask the vendor for an EU-scoped key." ;;
      *)   echo "    ?    - unexpected; body below"
           printf '%s' "$out" | grep -v '^__' | head -3 | sed 's/^/      /' ;;
    esac
  fi
}

check "$EU_HOST" "EU     " "eu"
check "$GLOBAL_HOST" "Global " "global"

cat <<'EOF'

============================================================
 What this means
============================================================
  The EU line is the one that decides this.

  EU PASS   -> Patient audio can be processed in the EU. Good.
  EU FAIL + Global PASS -> The account is not enabled for EU
               processing. Contact the vendor before going live.

  EU FAIL + Global FAIL -> The KEY IS INVALID (expired, revoked, or
               mistyped). This is not a residency problem. Note that
               live transcription will also be failing in production
               if this is the key the application is using.

  The Global line is informational and inverted:

  Global rejected -> BEST case. The key is EU-scoped, so audio
                     cannot reach the US even by misconfiguration.
  Global accepted -> Not a fault, but the key is not region-locked.
============================================================
EOF
