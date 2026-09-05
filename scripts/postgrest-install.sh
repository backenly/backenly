#!/usr/bin/env bash
#
# PHASE 3 — install every database-side piece the PostgREST data plane needs.
#
# Idempotent: safe to re-run after a deploy, and re-running is the intended way
# to pick up changes to the SQL. Installs FUNCTIONS, TRIGGERS AND THE POSTGREST
# ROLES ONLY — it does not register a schema, does not grant a project anything,
# and does not move any traffic. Cutover is a separate, explicit step.
#
# Must reach the database as a PostgreSQL superuser: the registry writes
# role-level settings (ALTER ROLE ... SET), and event triggers can only be
# created by a superuser.
#
# WHERE the database is, is chosen explicitly. This script used to hardcode
# `sudo -u postgres`, which meant the documented Docker quickstart could not run
# its own prerequisite step, and a clone under a 0750 home directory failed with
# "Permission denied" because the postgres OS user cannot traverse /home/<user>.
# See scripts/lib/db-admin.sh.
#
#   bash scripts/postgrest-install.sh                        # Compose (default)
#   BACKENLY_DB_ADMIN=url \
#     BACKENLY_ADMIN_DATABASE_URL=postgresql://... \
#     bash scripts/postgrest-install.sh                      # any reachable DB
#   BACKENLY_DB_ADMIN=local bash scripts/postgrest-install.sh # local cluster
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/db-admin.sh
. "$DIR/lib/db-admin.sh"

db_admin_check

echo
echo "Installing PostgREST support objects via $(db_admin_describe)"
echo

for f in postgrest-schema-registry.sql postgrest-ddl-sync.sql; do
  echo "  → $f"
  db_admin_sql_file "$DIR/sql/$f"
done

echo
echo "Verifying:"

# Assert rather than announce. A green line printed without checking anything is
# worse than no line at all.
missing=0
for fn in \
  backenly_pgrst_current_schemas \
  backenly_pgrst_prune_schemas \
  backenly_pgrst_register_schema \
  backenly_pgrst_unregister_schema \
  backenly_pgrst_revoke_internal \
  backenly_pgrst_prepare_schema \
  backenly_pgrst_reload
do
  if [ "$(db_admin_psql -tAqc "SELECT count(*) FROM pg_proc WHERE proname = '$fn'" | tr -d '[:space:]')" = "0" ]; then
    echo "  MISSING function: $fn"
    missing=1
  fi
done

for trg in backenly_pgrst_schema_drop backenly_pgrst_ddl_sync
do
  if [ "$(db_admin_psql -tAqc "SELECT count(*) FROM pg_event_trigger WHERE evtname = '$trg'" | tr -d '[:space:]')" = "0" ]; then
    echo "  MISSING event trigger: $trg"
    missing=1
  fi
done

# The roles the event triggers GRANT to. A trigger that grants to a role nobody
# created aborts the CREATE SCHEMA that fired it, which is what deadlocked a
# fresh cluster before the SQL began creating these itself.
for role in anon authenticated service_role backenly_authenticator
do
  if [ "$(db_admin_psql -tAqc "SELECT count(*) FROM pg_roles WHERE rolname = '$role'" | tr -d '[:space:]')" = "0" ]; then
    echo "  MISSING role: $role"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo
  echo "  Install INCOMPLETE. Do not cut any project over until this is clean:"
  echo "  the drop trigger is what prevents one deleted project from returning"
  echo "  503 to every other tenant."
  exit 1
fi

echo "  7 functions + 2 event triggers + 4 roles present."
echo
echo "  Registered schemas: $(db_admin_psql -tAqc 'SELECT public.backenly_pgrst_current_schemas()' | tr -d '[:space:]')"
echo
echo "Next — give the roles passwords and per-schema grants:"
echo "  npx tsx scripts/setup-postgrest-roles.ts --project <id> --apply"
echo
