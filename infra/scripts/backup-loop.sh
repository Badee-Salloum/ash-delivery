#!/bin/sh
# Nightly backup sidecar.
#
# Runs on its OWN loop rather than inside the API process, so backups keep running while the app
# is in a crash loop — which is precisely when you are most likely to need one.
#
# Each night: pg_dump -Fc + the media volume, pushed to restic, then pruned to RETENTION_DAYS.
# The dump is streamed to restic without landing on disk first, so the VPS does not need room
# for a second copy of the database.
set -eu

RETENTION_DAYS="${RETENTION_DAYS:-90}"
BACKUP_HOUR="${BACKUP_HOUR:-2}"

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

if ! restic snapshots >/dev/null 2>&1; then
  log "initialising restic repository"
  restic init
fi

while true; do
  # Sleep until the next BACKUP_HOUR UTC.
  now_h=$(date -u +%-H)
  now_m=$(date -u +%-M)
  mins=$(( ((BACKUP_HOUR - now_h + 24) % 24) * 60 - now_m ))
  [ "$mins" -le 0 ] && mins=$((mins + 1440))
  log "next run in ${mins} minutes"
  sleep $((mins * 60))

  stamp=$(date -u +%Y%m%dT%H%M%SZ)

  # ── database ──────────────────────────────────────────────────────────────────────────
  # -Fc is the custom format: compressed, and restorable table-by-table with pg_restore.
  if pg_dump -Fc | restic backup --stdin --stdin-filename "ash-${stamp}.dump" --tag db; then
    log "database snapshot ok"
  else
    # Never exit on failure: a transient error must not silently stop all future backups.
    log "DATABASE BACKUP FAILED — will retry tomorrow"
  fi

  # ── media ─────────────────────────────────────────────────────────────────────────────
  if restic backup /app/media --tag media; then
    log "media snapshot ok"
  else
    log "MEDIA BACKUP FAILED"
  fi

  # SRS §7: 90-day retention. Keeping a few weeklies and monthlies costs almost nothing with
  # restic's deduplication and covers a corruption noticed late.
  restic forget --keep-daily "$RETENTION_DAYS" --keep-weekly 12 --keep-monthly 12 --prune || \
    log "prune failed (not fatal)"

  # A backup nobody verifies is a hope, not a backup.
  restic check --read-data-subset=5% || log "INTEGRITY CHECK FAILED"

  log "cycle complete: $(restic snapshots --json | grep -c short_id || echo '?') snapshots"
done
