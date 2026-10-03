#!/usr/bin/env bash
# ============================================================================
# DIRECT DATABASE ACCESS — network exposure (run as root on the database host)
# ============================================================================
# Idempotent companion to scripts/setup-direct-access.sql. Order matters:
#   1. npm run db:push                (creates public.schema_drift_events)
#   2. bash scripts/install-sql.sh scripts/setup-direct-access.sql
#   3. bash scripts/setup-direct-access.sh   (this file)
#
# Step 2 used to read `sudo -u postgres psql -d backenly -f <file>`. That failed
# on any normal clone: Ubuntu home directories are 0750, so the postgres user
# cannot traverse /home/<user> to reach the file, and psql exits "Permission
# denied". install-sql.sh redirects the file on stdin instead, so the operator's
# shell opens it. See scripts/lib/db-admin.sh.
#
# THIS script, unlike step 2, is genuinely local-only: it edits pg_hba.conf,
# opens a firewall port and restarts the service, all on the database host. It
# is not part of the Docker quickstart.
#
# Exposure model (deliberately narrow):
#   • Postgres listens on all interfaces, BUT pg_hba only admits remote
#     connections that are (a) TLS, (b) to the backenly database, (c) from a
#     member of backenly_external — i.e. the per-project bkn_ro_/bkn_rw_ roles.
#   • backenly_user and postgres remain localhost-only: no hostssl rule matches
#     them, so remote auth attempts are rejected before password check.
#   • scram-sha-256 everywhere; passwords are 32-char random secrets.
set -euo pipefail

HBA=$(sudo -u postgres psql -tAc "show hba_file" | tr -d '[:space:]')

echo "==> listen_addresses = '*' (was: $(sudo -u postgres psql -tAc 'show listen_addresses'))"
sudo -u postgres psql -c "ALTER SYSTEM SET listen_addresses = '*'" >/dev/null

if grep -q 'backenly_external' "$HBA"; then
  echo "==> pg_hba rules already present"
else
  echo "==> appending pg_hba rules to $HBA"
  cat >> "$HBA" <<'RULES'
# Backenly direct database access — ONLY per-project external roles, ONLY over
# TLS, ONLY the backenly DB (managed by scripts/setup-direct-access.sh)
hostssl backenly        +backenly_external      0.0.0.0/0               scram-sha-256
hostssl backenly        +backenly_external      ::/0                    scram-sha-256
RULES
fi

echo "==> firewall: allow 5432/tcp"
ufw allow 5432/tcp >/dev/null

echo "==> restarting postgresql (listen_addresses change requires restart)"
systemctl restart postgresql

sleep 2
echo "==> verify: listen_addresses = $(sudo -u postgres psql -tAc 'show listen_addresses')"
echo "==> verify: ssl = $(sudo -u postgres psql -tAc 'show ssl')"
echo "==> done"
