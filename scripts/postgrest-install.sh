#!/usr/bin/env bash
#
# PHASE 3 — install every database-side piece the PostgREST data plane needs.
#
# Idempotent: safe to re-run after a deploy, and re-running is the intended way
# to pick up changes to the SQL. Installs FUNCTIONS AND TRIGGERS ONLY — it does
# not register a schema, does not grant a project anything, and does not move
# any traffic. Cutover is a separate, explicit step.
#
# Must run as a PostgreSQL superuser: the registry writes role-level settings
# (ALTER ROLE ... SET), and event triggers can only be created by a superuser.
#
#   bash scripts/postgrest-install.sh
#
set -euo pipefail

DB="${PGDATABASE:-backenly}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sql"

run() {
  local file="$1"
  echo "  → $(basename "$file")"
  # ON_ERROR_STOP is the point of this wrapper. Without it psql reports failures
  # on stderr and still exits 0, so a broken install looks like a successful one
  # — and the first symptom would be a missing trigger during an outage.
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$file"
}

echo
echo "Installing PostgREST support objects into '$DB'"
echo

run "$DIR/postgrest-schema-registry.sql"
run "$DIR/postgrest-ddl-sync.sql"

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
  if [ "$(sudo -u postgres psql -tAqd "$DB" -c "SELECT count(*) FROM pg_proc WHERE proname = '$fn'")" = "0" ]; then
    echo "  MISSING function: $fn"
    missing=1
  fi
done

for trg in backenly_pgrst_schema_drop backenly_pgrst_ddl_sync
do
  if [ "$(sudo -u postgres psql -tAqd "$DB" -c "SELECT count(*) FROM pg_event_trigger WHERE evtname = '$trg'")" = "0" ]; then
    echo "  MISSING event trigger: $trg"
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

echo "  7 functions + 2 event triggers present."
echo
echo "  Registered schemas: $(sudo -u postgres psql -tAqd "$DB" -c 'SELECT public.backenly_pgrst_current_schemas()')"
echo
echo "Next — cut a project over (migrates policies AND flips the flag in one"
echo "transaction; dry run first):"
echo "  npx tsx scripts/cutover-postgrest.ts --project <id>"
echo "  npx tsx scripts/cutover-postgrest.ts --project <id> --apply"
echo
