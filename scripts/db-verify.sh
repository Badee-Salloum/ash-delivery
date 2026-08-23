#!/usr/bin/env bash
# Apply the migrations to a scratch database and PROVE the guards.
#
# This is the script that turns 0006 from "written" into "verified". It is safe to re-run: it
# drops and recreates the scratch database every time.
#
#   docker compose -f infra/compose/docker-compose.dev.yml up -d
#   ./scripts/db-verify.sh
#
# Env overrides: PGHOST PGPORT PGUSER PGPASSWORD VERIFY_DB.
# Destructive execution additionally requires ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS=1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-55432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
VERIFY_DB="${VERIFY_DB:-ash_guardcheck}"

if [[ "${ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS:-}" != "1" ]]; then
  echo "refusing destructive database verification: set ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS=1" >&2
  exit 2
fi
if [[ ! "$VERIFY_DB" =~ ^ash_(test|conformance|release_gate|guardcheck|integritycheck)(_[A-Za-z0-9_]+)?$ ]]; then
  echo "refusing destructive database verification: VERIFY_DB is not disposable-test allowlisted" >&2
  exit 2
fi
case "$PGHOST" in
  localhost|127.0.0.1|::1) ;;
  *)
    if [[ "${ASH_ALLOW_REMOTE_DESTRUCTIVE_DATABASE_TESTS:-}" != "1" ]]; then
      echo "refusing destructive database verification: remote PGHOST requires ASH_ALLOW_REMOTE_DESTRUCTIVE_DATABASE_TESTS=1" >&2
      exit 2
    fi
    ;;
esac

if ! command -v psql >/dev/null 2>&1; then
  cat >&2 <<'MSG'
psql is not on PATH.

The migrations and their guards CANNOT be verified without a real PostgreSQL. Either:
  • install the postgresql-client package, or
  • run this inside the container:
      docker compose -f infra/compose/docker-compose.dev.yml exec -T postgres bash

Until this script has run green, treat every claim in packages/db/migrations/0006 as UNPROVEN.
MSG
  exit 2
fi

echo "── recreating scratch database ${VERIFY_DB} on ${PGHOST}:${PGPORT}"
psql -v ON_ERROR_STOP=1 -v db_name="$VERIFY_DB" -d postgres -c 'DROP DATABASE IF EXISTS :"db_name";' >/dev/null
psql -v ON_ERROR_STOP=1 -v db_name="$VERIFY_DB" -d postgres -c 'CREATE DATABASE :"db_name";' >/dev/null

for f in "$ROOT"/packages/db/migrations/*.sql; do
  echo "── applying $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -d "$VERIFY_DB" -f "$f"
done

echo "── proving the guards"
psql -v ON_ERROR_STOP=1 -d "$VERIFY_DB" -f "$ROOT/packages/db/verify-guards.sql"

# A guard that cannot fail is decoration. Confirm the harness has teeth by removing one guard
# and checking that verification then FAILS.
echo "── negative-testing the harness (removing a guard must break verification)"
psql -v ON_ERROR_STOP=1 -q -d "$VERIFY_DB" \
     -c 'DROP TRIGGER journal_lines_week_locked ON journal_lines;'
negative_output="$(mktemp)"
if psql -v ON_ERROR_STOP=1 -q -d "$VERIFY_DB" \
        -f "$ROOT/packages/db/verify-guards.sql" >"$negative_output" 2>&1; then
  rm -f "$negative_output"
  echo "FAIL: verify-guards.sql passed with a guard removed — the harness has no teeth" >&2
  exit 1
fi
if ! grep -Fq 'GUARD FAILED: a locked-week LINE amount was updated' "$negative_output"; then
  cat "$negative_output" >&2
  rm -f "$negative_output"
  echo "FAIL: verification failed before it exercised the deliberately removed guard" >&2
  exit 1
fi
rm -f "$negative_output"
echo "   OK: removing a guard makes verification fail, as it must"

psql -v ON_ERROR_STOP=1 -v db_name="$VERIFY_DB" -d postgres -c 'DROP DATABASE :"db_name";' >/dev/null
echo
echo "All database guards verified against real PostgreSQL."
