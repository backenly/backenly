#!/usr/bin/env bash
# ============================================================================
# Backenly PostgreSQL backup — hardened, self-verifying, off-box capable.
# ============================================================================
# Runs as root on the deployment host (cron). Produces, every run:
#   • globals-<DATE>.sql       — roles + grants (pg_dumpall --globals-only),
#                                incl. backenly_user / bkn_* / backenly_external
#   • backenly-<DATE>.dump     — full DB, custom format (pg_dump -Fc):
#                                compressed, integrity-checkable, selectively
#                                restorable. One dump = platform + every tenant
#                                (all workspace_* schemas live in one DB).
#
# WHY THIS REWRITE (the old script failed silently for ~4 months):
#   1. `pg_dump | gzip; if [ $? ]` checked GZIP's exit code, not pg_dump's — a
#      truncated dump reported success. Fixed: `set -o pipefail` + custom
#      format (no pipe) + an explicit `pg_restore --list` integrity gate.
#   2. Cron ran `./backup.sh`; a git checkout dropped the +x bit → months of
#      "Permission denied". Fixed: install-cron.sh invokes `bash <script>`, so
#      a lost execute bit can never disable backups again.
#   3. Backups lived only on the same disk → zero protection against the disk
#      failure we actually fear. Fixed: optional off-box push (rclone), and a
#      loud LAST_BACKUP_FAILED marker so silence can't mask failure again.
#
# Dumps run as the postgres superuser via peer auth (no password in env, and a
# complete dump regardless of per-table ownership from direct-access roles).
#
# Off-box (the SPOF fix): set BACKUP_REMOTE to an rclone remote path, e.g.
#   BACKUP_REMOTE="b2:backenly-backups"   (Backblaze B2 — pennies at this size)
# Configure once:  rclone config   (see scripts/OFFBOX_BACKUP.md)
# ============================================================================
set -Eeuo pipefail

# Load backup config from .env so BACKUP_REMOTE (the off-box target) and any
# BACKUP_* overrides are picked up when run from cron with a bare environment.
# Only BACKUP_* keys are sourced — never the whole .env into the shell.
#
# Derived from this script's OWN location, not hardcoded. The previous default
# was /opt/backenly/.env, a path that does not exist on this host — the live
# checkout is /var/www/backenly/backenly. That is the identical bug the header
# above documents fixing for APP_DIR in deploy.sh; ENV_FILE was missed.
#
# It failed silently and expensively: `[ -f "$ENV_FILE" ]` was simply false, so
# BACKUP_REMOTE never entered the environment, the off-box push was skipped, and
# the log said "BACKUP_REMOTE not set (or rclone missing)" — which reads like a
# configuration choice rather than a broken path. Off-box copies stopped on
# 2026-07-23 and nobody could tell from the message, so for seven days every
# backup existed on exactly one disk while the log reported success.
_BACKUP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$_BACKUP_SCRIPT_DIR/.env}"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in
      BACKUP_REMOTE=*|BACKUP_DB_NAME=*|BACKUP_DIR=*|BACKUP_KEEP_DAYS=*) export "${line?}" ;;
    esac
  done < <(grep -E '^BACKUP_(REMOTE|DB_NAME|DIR|KEEP_DAYS)=' "$ENV_FILE" || true)
fi

DB_NAME="${BACKUP_DB_NAME:-backenly}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/backenly}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
DATE="$(date +%Y-%m-%d_%H%M)"
DUMP_FILE="$BACKUP_DIR/backenly-$DATE.dump"
GLOBALS_FILE="$BACKUP_DIR/globals-$DATE.sql"
STATUS_OK="$BACKUP_DIR/LAST_BACKUP_OK"
STATUS_FAIL="$BACKUP_DIR/LAST_BACKUP_FAILED"
LOCK="/tmp/backenly-backup.lock"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Any error trips this: record a loud, machine-readable failure marker so a
# broken backup is never silent again (the exact trap that hid the 4-month gap).
fail() {
  local line=$1
  { echo "FAILED at $(date -Iseconds) (line $line)"; } > "$STATUS_FAIL" 2>/dev/null || true
  rm -f "$STATUS_OK" 2>/dev/null || true
  log "ERROR: backup failed at line $line"
  exit 1
}
trap 'fail $LINENO' ERR

# Single-run lock — never let a slow run overlap the next cron tick.
exec 9>"$LOCK"
if ! flock -n 9; then log "another backup is running — exiting"; exit 0; fi

mkdir -p "$BACKUP_DIR"
log "Starting backup of '$DB_NAME'…"

# ── 1. Globals (roles + grants) ──────────────────────────────────────────────
sudo -u postgres pg_dumpall --globals-only > "$GLOBALS_FILE"
log "Globals dumped: $(du -h "$GLOBALS_FILE" | cut -f1)"

# ── 2. Full database, custom format ──────────────────────────────────────────
# --no-privileges keeps the dump portable across clusters; roles are restored
# separately from the globals file. Custom format compresses internally.
# Write via stdout so root's shell creates the file — `pg_dump -f` would try to
# open it AS the postgres user, which cannot write to the root-owned backup dir.
sudo -u postgres pg_dump -Fc --no-privileges "$DB_NAME" > "$DUMP_FILE"
log "Database dumped: $(du -h "$DUMP_FILE" | cut -f1)"

# ── 3. Integrity gate — a dump you can't list is a dump you can't restore ────
if ! sudo -u postgres pg_restore --list "$DUMP_FILE" > /dev/null 2>&1; then
  log "integrity check FAILED — dump is not readable by pg_restore"
  false
fi
ENTRIES="$(sudo -u postgres pg_restore --list "$DUMP_FILE" | grep -c ';' || true)"
log "Integrity OK — $ENTRIES catalog entries readable"

# ── 4. Off-box copy (the SPOF fix) ───────────────────────────────────────────
if [ -n "${BACKUP_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$DUMP_FILE"    "$BACKUP_REMOTE" --no-traverse
  rclone copy "$GLOBALS_FILE" "$BACKUP_REMOTE" --no-traverse
  log "Pushed off-box → $BACKUP_REMOTE"
  # Mirror retention off-box too.
  rclone delete "$BACKUP_REMOTE" --min-age "${KEEP_DAYS}d" --include "backenly-*.dump"  2>/dev/null || true
  rclone delete "$BACKUP_REMOTE" --min-age "${KEEP_DAYS}d" --include "globals-*.sql"     2>/dev/null || true
else
  # Name the ACTUAL reason. The combined "not set (or rclone missing)" reads as
  # a deliberate choice, so a broken ENV_FILE path looked identical to running
  # without off-box backup on purpose — and stayed that way for seven days.
  if [ -z "${BACKUP_REMOTE:-}" ]; then
    log "WARNING: BACKUP_REMOTE is empty after reading $ENV_FILE — backup is ON-DISK ONLY."
    if [ ! -f "$ENV_FILE" ]; then
      log "         Cause: $ENV_FILE does not exist, so no BACKUP_* config was loaded."
    else
      log "         Cause: $ENV_FILE exists but contains no BACKUP_REMOTE= line."
    fi
  else
    log "WARNING: rclone is not installed — backup is ON-DISK ONLY (BACKUP_REMOTE is set)."
  fi
  log "         A disk failure loses it. See scripts/OFFBOX_BACKUP.md to fix."
fi

# ── 5. Retention (local) ─────────────────────────────────────────────────────
find "$BACKUP_DIR" -name "backenly-*.dump" -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name "globals-*.sql"   -mtime "+$KEEP_DAYS" -delete

# ── 6. Success marker + heartbeat ────────────────────────────────────────────
rm -f "$STATUS_FAIL" 2>/dev/null || true
{
  echo "OK at $(date -Iseconds)"
  echo "dump=$DUMP_FILE"
  echo "bytes=$(stat -c%s "$DUMP_FILE")"
  echo "offbox=${BACKUP_REMOTE:-none}"
} > "$STATUS_OK"

log "Backup complete. Local copies:"
ls -lh "$BACKUP_DIR"/backenly-*.dump | tail -5
