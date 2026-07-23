#!/usr/bin/env bash
# ============================================================================
# Install the backup + restore-verification crons (idempotent, root on box).
# ============================================================================
# Invokes the scripts via `bash <path>` — NOT `<path>` — so a lost execute bit
# (from a git checkout) can never silently disable backups again. That single
# character was the root cause of the ~4-month backup outage.
#
#   • 02:00 daily  — backup.sh                (dump + integrity + off-box + retention)
#   • 03:30 Sunday — verify-backup-restore.sh (prove the latest dump restores)
#
# Both append to /var/log/backenly-backup.log. Run once:
#   bash scripts/install-backup-cron.sh
# ============================================================================
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/backenly}"
LOG="/var/log/backenly-backup.log"
DAILY="0 2 * * * bash $APP_DIR/scripts/backup.sh >> $LOG 2>&1"
WEEKLY="30 3 * * 0 bash $APP_DIR/scripts/verify-backup-restore.sh >> $LOG 2>&1"

touch "$LOG"

# Strip any prior backenly backup/verify lines, then re-add the corrected ones.
current="$(crontab -l 2>/dev/null | grep -v 'scripts/backup.sh' | grep -v 'scripts/verify-backup-restore.sh' || true)"
printf '%s\n%s\n%s\n' "$current" "$DAILY" "$WEEKLY" | sed '/^$/d' | crontab -

echo "Installed crons:"
crontab -l | grep -E 'backup\.sh|verify-backup-restore\.sh'
