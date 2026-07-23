#!/usr/bin/env bash
# ============================================================================
# Wire off-box backups to Backblaze B2 (S3-style object storage, rclone).
# ============================================================================
# Secret hygiene: this script reads the B2 key from the ENVIRONMENT, so YOU run
# it in your own SSH session and the credential never appears in a shared chat
# or in this repo. It lands only in the server's .env (the right place for it).
#
# Prereq (on YOUR side):
#   1. Backblaze B2 → create a PRIVATE bucket, e.g. "backenly-backups".
#   2. Create an Application Key SCOPED TO THAT BUCKET (not the master key) —
#      note the keyID and the applicationKey (shown once).
#
# Run on the box (fill in your two values):
#   B2_KEY_ID=xxxxxxxxxxxx B2_APP_KEY=yyyyyyyyyyyyyyyyyyyyyyyyyyy \
#     bash scripts/setup-offbox-b2.sh
#
# Optional: B2_BUCKET=backenly-backups (default).
#
# It configures the rclone remote, sets BACKUP_REMOTE in .env, then proves it by
# pushing the current backup and listing it back. Idempotent + revocable (rotate
# the key in the B2 console any time; re-run to update). Nothing here is secret.
# ============================================================================
set -Eeuo pipefail

: "${B2_KEY_ID:?set B2_KEY_ID=<your B2 keyID>}"
: "${B2_APP_KEY:?set B2_APP_KEY=<your B2 applicationKey>}"
BUCKET="${B2_BUCKET:-backenly-backups}"
REMOTE_NAME="b2"
REMOTE_PATH="$REMOTE_NAME:$BUCKET"
ENV_FILE="${ENV_FILE:-/opt/backenly/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/backenly}"

echo "==> configuring rclone remote '$REMOTE_NAME' (Backblaze B2)"
rclone config delete "$REMOTE_NAME" 2>/dev/null || true
rclone config create "$REMOTE_NAME" b2 \
  account "$B2_KEY_ID" key "$B2_APP_KEY" hard_delete true \
  --non-interactive >/dev/null

echo "==> verifying access to bucket '$BUCKET'"
if ! rclone lsd "$REMOTE_PATH" >/dev/null 2>/tmp/b2_err && ! rclone mkdir "$REMOTE_PATH" 2>/tmp/b2_err; then
  echo "FATAL: cannot reach bucket '$BUCKET'. Check the bucket exists, is spelled"
  echo "right, and the app key is scoped to it. Details:"; cat /tmp/b2_err; exit 1
fi

echo "==> persisting BACKUP_REMOTE in $ENV_FILE"
if grep -q '^BACKUP_REMOTE=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^BACKUP_REMOTE=.*|BACKUP_REMOTE=$REMOTE_PATH|" "$ENV_FILE"
else
  printf '\n# Off-box backup target (Backblaze B2 via rclone)\nBACKUP_REMOTE=%s\n' "$REMOTE_PATH" >> "$ENV_FILE"
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
echo "==> DONE. The nightly cron keeps this current (BACKUP_REMOTE is set)."
echo "    Verify anytime with:  rclone ls $REMOTE_PATH"