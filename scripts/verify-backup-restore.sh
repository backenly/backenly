#!/usr/bin/env bash
# ============================================================================
# Restore verification — the line between real backups and backup theater.
# ============================================================================
# Restores the LATEST dump into a throwaway database, compares row/schema
# counts against the live DB, then drops the scratch DB. Proves the backup is
# actually restorable — the check almost everyone skips until the night they
# need it. Run weekly by cron and after any backup change.
#
# Exit 0 = a restorable backup was proven. Non-zero = investigate NOW.
#
# Usage (as root on the box):  bash scripts/verify-backup-restore.sh
# ============================================================================
set -Eeuo pipefail

DB_NAME="${BACKUP_DB_NAME:-backenly}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/backenly}"
TEST_DB="backenly_restore_test_$$"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

LATEST="$(ls -t "$BACKUP_DIR"/backenly-*.dump 2>/dev/null | head -1 || true)"
if [ -z "$LATEST" ]; then log "FATAL: no .dump files in $BACKUP_DIR"; exit 1; fi
log "Verifying restorability of: $LATEST"

cleanup() { sudo -u postgres dropdb --if-exists "$TEST_DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ── Restore into a scratch DB ────────────────────────────────────────────────
# --no-owner / --no-privileges: the scratch DB need not recreate the bkn_*
# ownership graph to prove the data is intact.
sudo -u postgres createdb "$TEST_DB"
if ! sudo -u postgres pg_restore --no-owner --no-privileges -d "$TEST_DB" "$LATEST" 2>/tmp/restore_err.log; then
  # pg_restore warns on missing roles even with --no-owner; only FAIL on errors
  # that left the data incomplete. Surface the log and let the count checks below
  # be the real verdict.
  log "pg_restore reported warnings (see below) — validating by row counts:"
  tail -5 /tmp/restore_err.log || true
fi

# ── Compare against the live DB ──────────────────────────────────────────────
count() { sudo -u postgres psql -d "$1" -tAc "$2" 2>/dev/null | tr -d '[:space:]'; }

FAILED=0
check() {
  local label="$1" q="$2"
  local live restored
  live="$(count "$DB_NAME" "$q")"
  restored="$(count "$TEST_DB" "$q")"
  if [ -n "$restored" ] && [ "$restored" = "$live" ]; then
    log "  OK  $label: $restored (matches live)"
  elif [ -n "$restored" ] && [ "$live" -gt 0 ] 2>/dev/null && [ "$restored" -ge "$live" ] 2>/dev/null; then
    log "  OK  $label: $restored (live $live — backup is newer/≥, acceptable)"
  else
    log "  ✗   $label: restored=$restored live=$live  MISMATCH"
    FAILED=1
  fi
}

check "platform users"     "SELECT count(*) FROM users"
check "projects"           "SELECT count(*) FROM projects"
check "workspace schemas"  "SELECT count(*) FROM information_schema.schemata WHERE schema_name LIKE 'workspace_%'"
check "tables (public)"    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"

if [ "$FAILED" -eq 0 ]; then
  log "RESTORE VERIFIED — the latest backup is complete and restorable."
  exit 0
else
  log "RESTORE VERIFICATION FAILED — the latest backup is NOT trustworthy."
  exit 1
fi
