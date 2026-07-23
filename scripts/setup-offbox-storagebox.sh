#!/usr/bin/env bash
# ============================================================================
# Wire off-box backups to a Hetzner Storage Box (SSH-key auth, rclone SFTP).
# ============================================================================
# Prereq (one-time, on YOUR side — no secret comes to the server):
#   1. Storage Box console → enable "SSH support".
#   2. Add this server's backup public key to the Storage Box:
#        /root/.ssh/backenly_backup.pub
#   3. Note the Storage Box host (u######.your-storagebox.de) and user (u######).
#
# Then run on the box:
#   STORAGEBOX_HOST=u123456.your-storagebox.de STORAGEBOX_USER=u123456 \
#     bash scripts/setup-offbox-storagebox.sh
#
# What it does: configures an rclone SFTP remote using the key, creates a
# backenly-backups/ dir on the box, sets BACKUP_REMOTE in .env, then proves it
# by pushing the current backup and listing it back. Idempotent.
# ============================================================================
set -Eeuo pipefail

HOST="${STORAGEBOX_HOST:?set STORAGEBOX_HOST=u######.your-storagebox.de}"
USER_="${STORAGEBOX_USER:?set STORAGEBOX_USER=u######}"
KEY="/root/.ssh/backenly_backup"
REMOTE_NAME="storagebox"
REMOTE_PATH="$REMOTE_NAME:backenly-backups"
ENV_FILE="${ENV_FILE:-/opt/backenly/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/backenly}"

[ -f "$KEY" ] || { echo "FATAL: $KEY missing — generate it first."; exit 1; }

echo "==> configuring rclone remote '$REMOTE_NAME' → $USER_@$HOST:23 (key auth)"
# Storage Box SFTP is port 23. Recreate the remote so re-runs pick up changes.
rclone config delete "$REMOTE_NAME" 2>/dev/null || true
rclone config create "$REMOTE_NAME" sftp \
  host "$HOST" user "$USER_" port 23 key_file "$KEY" \
  shell_type unix --non-interactive >/dev/null

echo "==> testing connectivity + creating backenly-backups/ on the box"
if ! rclone mkdir "$REMOTE_PATH" 2>/tmp/rclone_err; then
  echo "FATAL: could not reach the Storage Box. Most likely the public key isn't"
  echo "added yet, or SSH support is off. Details:"; cat /tmp/rclone_err; exit 1
fi

echo "==> persisting BACKUP_REMOTE in $ENV_FILE"
if grep -q '^BACKUP_REMOTE=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^BACKUP_REMOTE=.*|BACKUP_REMOTE=$REMOTE_PATH|" "$ENV_FILE"
else
  printf '\n# Off-box backup target (Hetzner Storage Box via rclone SFTP)\nBACKUP_REMOTE=%s\n' "$REMOTE_PATH" >> "$ENV_FILE"
fi

echo "==> proving it: pushing the latest local backup off-box"
LATEST_DUMP="$(ls -t "$BACKUP_DIR"/backenly-*.dump 2>/dev/null | head -1 || true)"
if [ -n "$LATEST_DUMP" ]; then
  rclone copy "$LATEST_DUMP" "$REMOTE_PATH" --no-traverse
  LATEST_GLOBALS="$(ls -t "$BACKUP_DIR"/globals-*.sql 2>/dev/null | head -1 || true)"
  [ -n "$LATEST_GLOBALS" ] && rclone copy "$LATEST_GLOBALS" "$REMOTE_PATH" --no-traverse
fi

echo "==> off-box contents now:"
rclone ls "$REMOTE_PATH"
echo "==> DONE. Nightly cron will keep this current (BACKUP_REMOTE is set)."
