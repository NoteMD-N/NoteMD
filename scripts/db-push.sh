#!/usr/bin/env bash
#
# Apply migrations to a named environment.
#
# `supabase db push` on its own targets whatever project_id is written into
# supabase/config.toml, which is production. That is a bad default once a
# staging project exists: the difference between a rehearsal and a live schema
# change becomes a file nobody re-reads. This script makes the target an
# argument, and requires typed confirmation before touching production.
#
# Usage:
#   ./scripts/db-push.sh staging
#   ./scripts/db-push.sh production
#   ./scripts/db-push.sh staging --dry-run
#
# The database password is read from the environment, never from the repo:
#   export SUPABASE_DB_PASSWORD_STAGING='...'
#   export SUPABASE_DB_PASSWORD_PRODUCTION='...'
#
# Find it at: Supabase Dashboard -> Settings -> Database -> Database password.
# It is only displayed at creation; use "Reset database password" if unknown.
#
set -euo pipefail

STAGING_REF="toeurvqqucloareeujfa"
PRODUCTION_REF="mdunhinhsrdrilxcdbvq"

ENVIRONMENT="${1:-}"
shift || true

case "$ENVIRONMENT" in
  staging)
    REF="$STAGING_REF"
    PASSWORD="${SUPABASE_DB_PASSWORD_STAGING:-}"
    PASSWORD_VAR="SUPABASE_DB_PASSWORD_STAGING"
    ;;
  production)
    REF="$PRODUCTION_REF"
    PASSWORD="${SUPABASE_DB_PASSWORD_PRODUCTION:-}"
    PASSWORD_VAR="SUPABASE_DB_PASSWORD_PRODUCTION"
    ;;
  *)
    echo "Usage: $0 {staging|production} [--dry-run]" >&2
    exit 64
    ;;
esac

if [[ -z "$PASSWORD" ]]; then
  echo "error: \$$PASSWORD_VAR is not set." >&2
  echo "       Export it for this shell only; do not add it to a file in the repo:" >&2
  echo "         export $PASSWORD_VAR='your-real-password'" >&2
  exit 78
fi

# Catch the placeholder being pasted verbatim out of a command example. The
# CLI's own error for this is a URL parse failure, which does not point at the
# actual mistake.
PASSWORD_LOWER="$(printf '%s' "$PASSWORD" | tr '[:upper:]' '[:lower:]')"
if [[ "$PASSWORD" == *"<"* || "$PASSWORD" == *">"* \
   || "$PASSWORD_LOWER" == your-* || "$PASSWORD_LOWER" == *"password"* \
   || "$PASSWORD_LOWER" == "changeme" || "$PASSWORD_LOWER" == "xxx"* ]]; then
  echo "error: \$$PASSWORD_VAR still contains a placeholder, not a password." >&2
  echo "       Value starts: ${PASSWORD:0:12}..." >&2
  echo "       Get the real one from Supabase Dashboard -> Settings -> Database." >&2
  exit 78
fi

# Production changes get a deliberate pause. Staging does not — the whole point
# of staging is that it is cheap to rehearse against.
if [[ "$ENVIRONMENT" == "production" ]]; then
  echo
  echo "About to apply migrations to PRODUCTION ($REF)."
  echo "This database holds real patient records."
  echo
  read -r -p 'Type "production" to continue: ' CONFIRM
  if [[ "$CONFIRM" != "production" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

# Let the CLI resolve the connection itself rather than assembling a URL here.
# Building one by hand meant guessing the pooler hostname per region, and broke
# outright on any password containing @ / : or #, which are legal in a Supabase
# password but need percent-encoding inside a URL. The CLI reads
# SUPABASE_DB_PASSWORD natively and handles both.
export SUPABASE_DB_PASSWORD="$PASSWORD"

echo "==> Linking to ${ENVIRONMENT} (${REF})"
supabase link --project-ref "$REF" >/dev/null

echo "==> Applying migrations to ${ENVIRONMENT} (${REF})"
supabase db push "$@"

echo "==> Done. Migrations in supabase/migrations are now applied to ${ENVIRONMENT}."
echo "    The CLI is now linked to ${ENVIRONMENT}; re-run this script to switch."
