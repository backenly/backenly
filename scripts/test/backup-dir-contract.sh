#!/usr/bin/env bash
# ============================================================================
# The cluster backup destination must not follow the Web application's
# BACKUP_DIR.
# ============================================================================
# On 2026-09-06 BACKUP_DIR was set in .env to
# /var/backups/backenly/workspace-backups so that per-project workspace dumps
# would stop stranding under .next/standalone/backups. scripts/backup.sh read
# the same variable out of the same file, so the 02:00 cron the next night wrote
# the CLUSTER dump, the globals file and LAST_BACKUP_OK into the workspace
# backup tree, and the marker at /var/backups/backenly/LAST_BACKUP_OK went
# stale while the log still said success.
#
# One name meant two things. These assertions pin the split so it cannot come
# back: BACKUP_DIR must have no influence here, in the environment OR in .env.
#
# Uses `backup.sh --print-config`, which resolves paths and exits before it
# touches the database, the lock or the disk.
#
# Usage: bash scripts/test/backup-dir-contract.sh
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/backup.sh"
DEFAULT_DIR=/var/backups/backenly
PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

# Run backup.sh with a controlled environment and an ENV_FILE we supply, so the
# host's real .env can never influence the result.
cfg() { # cfg <env-file> [VAR=VAL ...]
  local envfile="$1"; shift
  env -i PATH="$PATH" HOME="$HOME" ENV_FILE="$envfile" "$@" \
    bash "$SCRIPT" --print-config
}

value() { grep -E "^$2=" <<<"$1" | cut -d= -f2-; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
EMPTY_ENV="$TMP/empty.env"; : > "$EMPTY_ENV"

echo "1. an explicit DATABASE_BACKUP_DIR wins, and BACKUP_DIR is ignored"
OUT="$(cfg "$EMPTY_ENV" BACKUP_DIR=/tmp/wrong DATABASE_BACKUP_DIR=/tmp/right)"
DIR="$(value "$OUT" DATABASE_BACKUP_DIR)"
[ "$DIR" = "/tmp/right" ] && ok "destination is /tmp/right" || bad "destination is '$DIR', expected /tmp/right"
case "$OUT" in
  */tmp/wrong*) bad "output still references /tmp/wrong" ;;
  *) ok "nothing resolves under BACKUP_DIR" ;;
esac

echo
echo "2. with DATABASE_BACKUP_DIR unset the default is $DEFAULT_DIR"
OUT="$(cfg "$EMPTY_ENV")"
DIR="$(value "$OUT" DATABASE_BACKUP_DIR)"
[ "$DIR" = "$DEFAULT_DIR" ] && ok "destination is $DEFAULT_DIR" || bad "destination is '$DIR'"

echo
echo "3. BACKUP_DIR alone cannot move cluster backups"
OUT="$(cfg "$EMPTY_ENV" BACKUP_DIR=/tmp/wrong)"
DIR="$(value "$OUT" DATABASE_BACKUP_DIR)"
[ "$DIR" = "$DEFAULT_DIR" ] && ok "still $DEFAULT_DIR despite BACKUP_DIR=/tmp/wrong" || bad "BACKUP_DIR redirected the cluster backup to '$DIR'"

echo
echo "4. BACKUP_DIR in .env cannot move them either (the actual incident)"
INCIDENT_ENV="$TMP/incident.env"
cat > "$INCIDENT_ENV" <<'ENVEOF'
BACKUP_DIR=/var/backups/backenly/workspace-backups
BACKUP_REMOTE=
ENVEOF
OUT="$(cfg "$INCIDENT_ENV")"
DIR="$(value "$OUT" DATABASE_BACKUP_DIR)"
[ "$DIR" = "$DEFAULT_DIR" ] && ok "still $DEFAULT_DIR with the incident .env" || bad "the incident .env redirected cluster backups to '$DIR'"
case "$OUT" in
  *workspace-backups*) bad "a path still lands in the workspace-backup tree" ;;
  *) ok "no path lands in the workspace-backup tree" ;;
esac

echo
echo "5. DATABASE_BACKUP_DIR in .env is honoured"
FILE_ENV="$TMP/file.env"
echo 'DATABASE_BACKUP_DIR=/tmp/from-env-file' > "$FILE_ENV"
OUT="$(cfg "$FILE_ENV")"
DIR="$(value "$OUT" DATABASE_BACKUP_DIR)"
[ "$DIR" = "/tmp/from-env-file" ] && ok "destination is /tmp/from-env-file" || bad "destination is '$DIR'"

echo
echo "6. every artefact of a run shares the one directory"
OUT="$(cfg "$EMPTY_ENV" DATABASE_BACKUP_DIR=/tmp/right)"
for k in DUMP_FILE GLOBALS_FILE STATUS_OK; do
  V="$(value "$OUT" "$k")"
  case "$V" in
    /tmp/right/*) ok "$k under /tmp/right" ;;
    *) bad "$k is '$V'" ;;
  esac
done

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
