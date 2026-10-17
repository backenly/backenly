#!/usr/bin/env bash
#
# REGIONAL DATABASE INITIALISATION
# ================================
# Turns an EMPTY PostgreSQL 16 database into a Backenly regional data-plane
# database: the roles, the PostgREST support objects, the drift-event table,
# the tables for the region's own customer data and its copy of what
# authorizes its requests, direct database access and its DDL capture, and the
# extensions the data plane uses. It holds no platform tables: those stay in
# the home region.
#
#   BOOTSTRAP_MODE=check bash tools/managed-db/regional/bootstrap.sh   # report, write nothing
#   BOOTSTRAP_MODE=apply bash tools/managed-db/regional/bootstrap.sh   # converge
#
# Run as the database's administrator (the RDS master on AWS), from inside the
# region's VPC: on AWS that is a one-off admin task, never a long-running
# service. Never part of `terraform apply`. One run at a time per database.
#
# THIS FILE IS THE ONE AUTHORITY ON ORDER, as scripts/postgrest-install.sh is for
# the PostgREST files (which it calls, rather than listing them: hand-ordering
# those bricked a database on 2026-09-09). Every step is idempotent and safe to
# re-run; the run records each step and the checksum of what it applied in
# backenly_meta.bootstrap_steps, so a re-run says what changed and what did not.
# The files it needs are listed in image-files.txt, which is all the image holds.
#
# ── Inputs (environment) ──────────────────────────────────────────────────────
#   DATABASE_URL                     the regional database, as its administrator
#   EXPECT_DATABASE                  optional; refuse unless DATABASE_URL names it
#   BOOTSTRAP_MODE                   check (default) or apply
#   BACKENLY_APP_VERIFIER            SCRAM-SHA-256 verifiers, never passwords
#   BACKENLY_BACKUP_VERIFIER           (tools/managed-db/regional/scram.ts), for the
#   BACKENLY_AUTHENTICATOR_VERIFIER    roles a check reports as missing, or named in
#                                      BOOTSTRAP_ROTATE. sql/roles.sql has the rules.
#   BOOTSTRAP_ROTATE                 optional, comma-separated roles whose existing
#                                      password is to be replaced deliberately
#   BOOTSTRAP_REHEARSAL              true only on a stock PostgreSQL 16 without
#                                      pgvector or the preload; refused on RDS
#
# Passwords never reach this script or the database: the operator's machine
# computes each verifier and keeps the password only long enough to write the
# connection string to Secrets Manager. On Backenly Cloud that is launch.ts,
# next to this file, which also runs this script as the region's one-off task.
#
# ── Output a launcher may read ────────────────────────────────────────────────
#   step <id>: pending | current | changed           (check)
#   step <id>: applied | re-applied                  (apply)
#   credential <role>: missing | unrecorded | recorded <time>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOTSTRAP_ROOT:-$(cd "$HERE/../../.." && pwd)}"
MODE="${BOOTSTRAP_MODE:-check}"
REHEARSAL="${BOOTSTRAP_REHEARSAL:-false}"
: "${DATABASE_URL:?DATABASE_URL must name the regional database}"

case "$MODE" in
  check) APPLY=false ;;
  apply) APPLY=true ;;
  *) echo "refusing: BOOTSTRAP_MODE must be check or apply, not \"$MODE\""; exit 2 ;;
esac
case "$REHEARSAL" in
  true | false) ;;
  *) echo "refusing: BOOTSTRAP_REHEARSAL must be true or false, not \"$REHEARSAL\""; exit 2 ;;
esac

# Which database did we actually reach? (as tools/managed-db/runner/entrypoint.sh)
if [ -n "${EXPECT_DATABASE:-}" ]; then
  _rest=${DATABASE_URL##*@}; _path=${_rest#*/}; _db=${_path%%\?*}
  if [ "$_db" != "$EXPECT_DATABASE" ]; then
    echo "refusing: connected database is \"$_db\", expected \"$EXPECT_DATABASE\""
    exit 2
  fi
fi

# The URL goes in -d, not first: psql on Windows stops reading options at the
# first plain argument, so every option after a leading URL would be ignored.
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -v allow_missing_extensions="$REHEARSAL" -d "$DATABASE_URL")

# One checksum over every file a step applies, in order.
checksum() { cat "$@" | sha256sum | cut -d' ' -f1; }

relation_exists() {
  [ "$("${PSQL[@]}" -tA -c "SELECT to_regclass('$1') IS NOT NULL")" = t ]
}

# The checksum a step last applied, or empty when the ledger has none.
recorded() {
  relation_exists backenly_meta.bootstrap_steps || return 0
  "${PSQL[@]}" -tA -c "SELECT checksum FROM backenly_meta.bootstrap_steps WHERE step = '$1'"
}

record() {
  "${PSQL[@]}" -c "INSERT INTO backenly_meta.bootstrap_steps (step, checksum, applied_at, applied_by)
                   VALUES ('$1', '$2', now(), current_user)
                   ON CONFLICT (step) DO UPDATE SET checksum = EXCLUDED.checksum,
                     applied_at = EXCLUDED.applied_at, applied_by = EXCLUDED.applied_by"
}

PENDING=0

# step <id> <files> [command...]: apply the step, then record the checksum of
# every file in <files> ('|'-separated, so a path may hold spaces). Without a
# command the single file is run with psql. In check mode, report whether the
# database has what the files say, and change nothing.
step() {
  local id="$1"; local -a files; IFS='|' read -r -a files <<< "$2"; shift 2
  local sum; sum="$(checksum "${files[@]}")"
  local have; have="$(recorded "$id")"
  if [ "$APPLY" != true ]; then
    if [ "$have" = "$sum" ]; then echo "  step $id: current (applied, files unchanged)"
    elif [ -n "$have" ]; then echo "  step $id: changed (applied, but its files have changed since)"
    else echo "  step $id: pending (not applied)"; PENDING=$((PENDING + 1)); fi
    return 0
  fi
  if [ "$#" -gt 0 ]; then "$@"; else "${PSQL[@]}" -f "${files[0]}"; fi
  record "$id" "$sum"
  if [ "$have" = "$sum" ]; then echo "  step $id: re-applied (files unchanged)"; else echo "  step $id: applied"; fi
}

postgrest_install() {
  BACKENLY_DB_ADMIN=url BACKENLY_ADMIN_DATABASE_URL="$DATABASE_URL" bash "$ROOT/scripts/postgrest-install.sh"
}

# Which login roles have the password this procedure set: what a launcher needs
# to know before deciding which verifiers to compute (sql/roles.sql).
credentials() {
  local join="SELECT NULL::timestamptz AS set_at"
  if relation_exists backenly_meta.bootstrap_credentials; then
    join="SELECT b.set_at FROM backenly_meta.bootstrap_credentials b WHERE b.role_name = v.role_name"
  fi
  "${PSQL[@]}" -tA -c "
    SELECT '  credential ' || v.role_name || ': ' || CASE
             WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v.role_name)
               THEN 'missing (the first apply must supply ' || v.variable || ')'
             WHEN c.set_at IS NULL
               THEN 'unrecorded (exists, but this procedure never set its password)'
             ELSE 'recorded ' || to_char(c.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
           END
      FROM (VALUES ('backenly_app', 'BACKENLY_APP_VERIFIER'),
                   ('backenly_backup', 'BACKENLY_BACKUP_VERIFIER'),
                   ('backenly_authenticator', 'BACKENLY_AUTHENTICATOR_VERIFIER')) AS v(role_name, variable)
      LEFT JOIN LATERAL ($join) c ON true
     ORDER BY 1"
}

echo
echo "Regional database initialisation ($MODE)"

# Preflight always runs, and refuses a database that is not an empty regional one.
"${PSQL[@]}" -f "$HERE/sql/preflight.sql"

if [ "$APPLY" = true ]; then
  "${PSQL[@]}" -f "$HERE/sql/ledger.sql"
fi

# Verifiers reach psql through the environment (\getenv in roles.sql), never as
# arguments, so they are not in the process list.
export BACKENLY_APP_VERIFIER="${BACKENLY_APP_VERIFIER:-}"
export BACKENLY_BACKUP_VERIFIER="${BACKENLY_BACKUP_VERIFIER:-}"
export BACKENLY_AUTHENTICATOR_VERIFIER="${BACKENLY_AUTHENTICATOR_VERIFIER:-}"
export BOOTSTRAP_ROTATE="${BOOTSTRAP_ROTATE:-}"

# 1. Roles first: the PostgREST files grant to public.backenly_app_role(), which
#    must already resolve to the application role rather than to the installer.
step roles "$HERE/sql/roles.sql"
# 2. The PostgREST registry, DDL sync and function roles, in their own order.
step postgrest "$ROOT/scripts/postgrest-install.sh|$ROOT/scripts/lib/db-admin.sh|$ROOT/scripts/sql/postgrest-schema-registry.sql|$ROOT/scripts/sql/postgrest-ddl-sync.sql|$ROOT/scripts/sql/function-roles.sql" postgrest_install
# 3. The one platform-shaped table a regional database holds, before the capture
#    triggers that write it.
step drift-events "$ROOT/scripts/sql/schema-drift-events.sql"
# 4. The region's projects' customer data on platform rows, which never
#    leaves the region (lib/data-plane/regional-bodies.ts).
step regional-bodies "$ROOT/scripts/sql/regional-bodies.sql"
# 5. The region's copy of what authorizes its projects' requests, delivered
#    from the home region (lib/auth-projection/deliver.ts).
step auth-projection "$ROOT/scripts/sql/auth-projection.sql"
# 6. Direct database access and its two DDL-capture event triggers.
step direct-access "$ROOT/scripts/setup-direct-access.sql"
# 7. Extensions the data plane and its probes use.
step extensions "$HERE/sql/extensions.sql"

credentials

# Verification fails the run when the database is not what the steps promise.
# It is read-only, so a check runs it too once every step is recorded: that is
# how a live region is audited.
if [ "$APPLY" = true ]; then
  "${PSQL[@]}" -f "$HERE/sql/verify.sql"
  echo "Regional database initialised and verified."
elif [ "$PENDING" -eq 0 ]; then
  "${PSQL[@]}" -f "$HERE/sql/verify.sql"
  echo "Check only: nothing was written. Every step is recorded, and the database verifies."
else
  echo "Check only: nothing was written. $PENDING step(s) not applied yet."
fi
