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
#   export SUPABASE_DB_PASSWORD_STAGING=...
#   export SUPABASE_DB_PASSWORD_PRODUCTION=...
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
  echo "       Export it for this shell only; do not add it to a file in the repo." >&2
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

DB_URL="postgresql://postgres.${REF}:${PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"

echo "==> Applying migrations to ${ENVIRONMENT} (${REF})"
# --db-url addresses the project directly, so the run does not depend on
# whichever project the CLI happens to be linked to.
supabase db push --db-url "$DB_URL" "$@"

echo "==> Done. Migrations in supabase/migrations are now applied to ${ENVIRONMENT}."
