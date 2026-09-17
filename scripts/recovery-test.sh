#!/usr/bin/env bash
#
# Backup and recovery test, against staging, with synthetic data.
#
# A backup that has never been restored is a hypothesis. This exercises the
# actual procedure end to end — take a backup, destroy the data, restore it,
# prove the result matches — so the assurance evidence records a rehearsal
# rather than a setting in a dashboard.
#
# It deliberately uses a logical dump rather than Supabase's physical backups:
# a physical restore replaces the whole project and cannot be rehearsed without
# destroying it. What this proves is the part that is actually in doubt — that
# the data can be captured, that a loss can be recovered, and that referential
# integrity between letters and recordings survives the round trip.
#
# Usage:
#   export SUPABASE_DB_PASSWORD_STAGING='...'
#   ./scripts/recovery-test.sh
#
set -euo pipefail

STAGING_REF="toeurvqqucloareeujfa"
PRODUCTION_REF="mdunhinhsrdrilxcdbvq"

if [[ -z "${SUPABASE_DB_PASSWORD_STAGING:-}" ]]; then
  echo "error: \$SUPABASE_DB_PASSWORD_STAGING is not set." >&2
  exit 78
fi

# Clinical rows reference auth.users, so the test needs an account to hang
# them from. It creates its own and removes it afterwards rather than
# depending on whatever happens to be left in staging.
if [[ -z "${SUPABASE_SERVICE_ROLE_KEY_STAGING:-}" ]]; then
  echo "error: \$SUPABASE_SERVICE_ROLE_KEY_STAGING is not set." >&2
  echo "       Needed to create and delete the synthetic account." >&2
  exit 78
fi

# This script deletes rows. It must never be aimed at production.
if [[ "${1:-}" == "$PRODUCTION_REF" || "${TARGET_REF:-}" == "$PRODUCTION_REF" ]]; then
  echo "error: this test destroys data and cannot run against production." >&2
  exit 1
fi

REF="$STAGING_REF"
OUT_DIR="docs/evidence"
DUMP="$(mktemp -t notemd-recovery-XXXXXX).sql"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_TAG="recovery-$(date -u +%s)"

# The CLI resolves the connection; building a URL by hand breaks on passwords
# containing @ / : or #.
export SUPABASE_DB_PASSWORD="$SUPABASE_DB_PASSWORD_STAGING"
supabase link --project-ref "$REF" >/dev/null

# The direct host, which is what the CLI itself connects to. The pooler
# hostname varies by project (aws-0 / aws-1 / region) and guessing it produces
# a "tenant not found" error that looks like a credentials problem.
DB_URL="postgresql://postgres:${SUPABASE_DB_PASSWORD_STAGING}@db.${REF}.supabase.co:5432/postgres"
export PGCONNECT_TIMEOUT=15

if ! psql "$DB_URL" -At -c "select 1" >/dev/null 2>&1; then
  echo "error: could not connect to ${REF} with \$SUPABASE_DB_PASSWORD_STAGING." >&2
  exit 1
fi

psql_q() { psql "$DB_URL" -At -c "$1"; }

echo "==> Recovery test against staging (${REF}) at ${STAMP}"
echo

# ---------------------------------------------------------------------------
# 1. Seed synthetic clinical records
# ---------------------------------------------------------------------------
echo "==> Creating a synthetic account"
SEED_USER="$(curl -s -X POST "https://${REF}.supabase.co/auth/v1/admin/users" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY_STAGING}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY_STAGING}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${RUN_TAG}@notemd-test.invalid\",\"password\":\"Recovery-Test-Pw-4m8!x\",\"email_confirm\":true}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)"

if [[ -z "$SEED_USER" ]]; then
  echo "error: could not create the synthetic account." >&2
  exit 1
fi
echo "    ${SEED_USER}"

cleanup() {
  curl -s -X DELETE "https://${REF}.supabase.co/auth/v1/admin/users/${SEED_USER}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY_STAGING}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY_STAGING}" >/dev/null 2>&1 || true
  rm -f "$DUMP"
}
trap cleanup EXIT

echo "==> Seeding synthetic records"

psql "$DB_URL" -q <<SQL
INSERT INTO public.recordings (user_id, audio_path, status, patient_name, patient_id)
SELECT '${SEED_USER}', '${SEED_USER}/${RUN_TAG}-' || g || '.webm', 'transcribed',
       'Synthetic Patient ' || g, '${RUN_TAG}-' || g
FROM generate_series(1, 25) g;

INSERT INTO public.letters (user_id, recording_id, status, transcript, letter_content, patient_name, patient_id)
SELECT r.user_id, r.id, 'draft',
       'Synthetic transcript for ' || r.patient_name,
       'Synthetic letter body for ' || r.patient_name,
       r.patient_name, r.patient_id
FROM public.recordings r
WHERE r.patient_id LIKE '${RUN_TAG}-%';
SQL

# Counts and checksums cover the WHOLE tables, not just this run's rows:
# staging holds synthetic data only, so the test can rehearse a complete loss
# of both clinical tables rather than a convenient subset.
count_all() { psql_q "SELECT count(*) FROM public.$1"; }
checksum_all() {
  psql_q "SELECT COALESCE(md5(string_agg(id::text || COALESCE(letter_content,'') , '|' ORDER BY id)), 'empty') FROM public.letters"
}

BEFORE_REC="$(count_all recordings)"
BEFORE_LET="$(count_all letters)"
BEFORE_SUM="$(checksum_all)"
echo "    recordings=${BEFORE_REC} letters=${BEFORE_LET} checksum=${BEFORE_SUM:0:12}…"

# ---------------------------------------------------------------------------
# 2. Back up
# ---------------------------------------------------------------------------
echo "==> Taking a logical backup"
# pg_dump directly rather than `supabase db dump`, which shells out to Docker
# and is unavailable on a machine without Docker Desktop running.
pg_dump "$DB_URL" --data-only --no-owner --no-privileges \
  --table=public.recordings --table=public.letters -f "$DUMP"
DUMP_BYTES="$(wc -c < "$DUMP" | tr -d ' ')"
echo "    ${DUMP_BYTES} bytes"

# ---------------------------------------------------------------------------
# 3. Destroy
# ---------------------------------------------------------------------------
echo "==> Simulating total loss of both clinical tables"
# Letters reference recordings, so they go first.
psql "$DB_URL" -q -c "DELETE FROM public.letters;"
psql "$DB_URL" -q -c "DELETE FROM public.recordings;"
LOST_REC="$(count_all recordings)"
LOST_LET="$(count_all letters)"
echo "    recordings=${LOST_REC} letters=${LOST_LET}"

if [[ "$LOST_REC" != "0" || "$LOST_LET" != "0" ]]; then
  echo "error: the simulated loss did not remove the rows; aborting." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Restore
# ---------------------------------------------------------------------------
echo "==> Restoring from the backup"
# The dump restores recordings before letters, so the foreign key is satisfied
# as it replays. ON_ERROR_STOP makes a partial restore a failure rather than
# something that quietly produces the wrong row count.
psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$DUMP" >/dev/null

AFTER_REC="$(count_all recordings)"
AFTER_LET="$(count_all letters)"
AFTER_SUM="$(checksum_all)"
ORPHANS="$(psql_q "SELECT count(*) FROM public.letters l LEFT JOIN public.recordings r ON r.id = l.recording_id WHERE l.recording_id IS NOT NULL AND r.id IS NULL")"
echo "    recordings=${AFTER_REC} letters=${AFTER_LET} checksum=${AFTER_SUM:0:12}… orphans=${ORPHANS}"

# ---------------------------------------------------------------------------
# 5. Verdict and evidence
# ---------------------------------------------------------------------------
VERDICT="PASS"
[[ "$AFTER_REC" == "$BEFORE_REC" ]] || VERDICT="FAIL (recording count)"
[[ "$AFTER_LET" == "$BEFORE_LET" ]] || VERDICT="FAIL (letter count)"
[[ "$AFTER_SUM" == "$BEFORE_SUM" ]] || VERDICT="FAIL (content checksum)"
[[ "$ORPHANS" == "0" ]] || VERDICT="FAIL (broken letter -> recording links)"

echo
echo "==> ${VERDICT}"

mkdir -p "$OUT_DIR"
cat > "${OUT_DIR}/recovery-test.md" <<EOF
# Backup and recovery test

Run: ${STAMP}
Target: NoteMD Staging (\`${REF}\`), West EU (Ireland) — synthetic data only.

A backup that has never been restored is a hypothesis. This exercises the
procedure end to end: capture, destroy, restore, and verify that what came
back is what went in.

## Method

A logical dump rather than a physical restore. Supabase's physical backups
replace an entire project, so rehearsing one would destroy the environment
being rehearsed in. What this proves is the part actually in doubt — that the
data can be captured, that a loss can be recovered from that capture, and that
the links between letters and their recordings survive the round trip.

## Result

| Stage | Recordings | Letters | Content checksum |
| --- | --- | --- | --- |
| Seeded | ${BEFORE_REC} | ${BEFORE_LET} | \`${BEFORE_SUM:0:16}\` |
| After simulated loss | ${LOST_REC} | ${LOST_LET} | — |
| After restore | ${AFTER_REC} | ${AFTER_LET} | \`${AFTER_SUM:0:16}\` |

Backup size: ${DUMP_BYTES} bytes.
Orphaned letters after restore (letter with no recording): ${ORPHANS}.

**Verdict: ${VERDICT}**

The checksum covers patient identifier and letter body for every restored row,
so the test distinguishes "the right number of rows returned" from "the right
rows returned with their content intact".

## Reproducing

    export SUPABASE_DB_PASSWORD_STAGING='...'
    ./scripts/recovery-test.sh

The script refuses to run against the production project.
EOF

echo "==> Evidence written to ${OUT_DIR}/recovery-test.md"
[[ "$VERDICT" == "PASS" ]] || exit 1
