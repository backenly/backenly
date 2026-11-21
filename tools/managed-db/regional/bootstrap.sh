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
#   BOOTSTRAP_MODE=check bash tools/managed-db/regional/bootstrap.sh         # report, write nothing
#   BOOTSTRAP_MODE=apply bash tools/managed-db/regional/bootstrap.sh         # converge
#
# A project can also have a database of its own on the region's instance,
# p_<32 lowercase hex>, cloned from a template the procedure keeps current. Two
# more modes, each run after an apply of the region's database, reach those
# databases from it (DATABASE_URL still names the region's database):
#
#   BOOTSTRAP_MODE=template bash tools/managed-db/regional/bootstrap.sh      # build or converge the template
#   BOOTSTRAP_MODE=project-dbs bash tools/managed-db/regional/bootstrap.sh   # converge every project database
#
# Run as the database's administrator (the RDS master on AWS), from inside the
# region's VPC: on AWS that is a one-off admin task, never a long-running
# service. Never part of `terraform apply`. One run at a time per instance.
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
#   BOOTSTRAP_MODE                   check (default), apply, template or project-dbs
#   BACKENLY_APP_VERIFIER            SCRAM-SHA-256 verifiers, never passwords
#   BACKENLY_BACKUP_VERIFIER           (tools/managed-db/regional/scram.ts), for the
#   BACKENLY_AUTHENTICATOR_VERIFIER    roles a check reports as missing, or named in
#                                      BOOTSTRAP_ROTATE. sql/roles.sql has the rules.
#   BACKENLY_DBCREATOR_VERIFIER      the same, for the role that creates project
#                                      databases; that role is made only by an
#                                      apply that supplies it
#   BOOTSTRAP_ROTATE                 optional, comma-separated roles whose existing
#                                      password is to be replaced deliberately
#   BOOTSTRAP_REHEARSAL              true only on a stock PostgreSQL 16 without
#                                      pgvector or the preload; refused on RDS
#   BOOTSTRAP_PRE_APPLY              true only for the check a launcher runs just
#                                      before its own apply (launch.ts). That check
#                                      reports, without failing on it, what steps
#                                      changed since they were applied have not
#                                      converged yet. Refused with an apply.
#   BOOTSTRAP_PROJECT_DATABASES      project-dbs only, and required there: the
#                                      project databases the platform knows in this
#                                      region, comma- or space-separated, or `none`,
#                                      or `sha256:<hex>` of their names sorted, one
#                                      per line, each line ending in a newline (for a
#                                      list too long for a task's environment). The
#                                      run refuses, touching nothing, unless it
#                                      names exactly the p_<hex> databases found.
#   BOOTSTRAP_PARALLELISM            project-dbs only: databases converged at once,
#                                      1 to 4 (default 3)
#
# Passwords never reach this script or the database: the operator's machine
# computes each verifier and keeps the password only long enough to write the
# connection string to Secrets Manager. On Backenly Cloud that is launch.ts,
# next to this file, which also runs this script as the region's one-off task.
#
# ── Output a launcher may read ────────────────────────────────────────────────
#   step <id>: pending | current | changed           (check)
#   step <id>: applied | re-applied                  (apply, template)
#   credential <role>: missing | unrecorded | recorded <time>
#   template backenly_project_template: created | exists           (template)
#   db <name>: current | applied <step,...> | failed <step>        (project-dbs)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOTSTRAP_ROOT:-$(cd "$HERE/../../.." && pwd)}"
MODE="${BOOTSTRAP_MODE:-check}"
REHEARSAL="${BOOTSTRAP_REHEARSAL:-false}"
PRE_APPLY="${BOOTSTRAP_PRE_APPLY:-false}"
: "${DATABASE_URL:?DATABASE_URL must name the regional database}"

case "$MODE" in
  check) APPLY=false ;;
  apply | template | project-dbs) APPLY=true ;;
  *) echo "refusing: BOOTSTRAP_MODE must be check, apply, template or project-dbs, not \"$MODE\""; exit 2 ;;
esac
case "$REHEARSAL" in
  true | false) ;;
  *) echo "refusing: BOOTSTRAP_REHEARSAL must be true or false, not \"$REHEARSAL\""; exit 2 ;;
esac
case "$PRE_APPLY" in
  true | false) ;;
  *) echo "refusing: BOOTSTRAP_PRE_APPLY must be true or false, not \"$PRE_APPLY\""; exit 2 ;;
esac
if [ "$APPLY" = true ] && [ "$PRE_APPLY" = true ]; then
  echo "refusing: BOOTSTRAP_PRE_APPLY marks the check a launcher runs before its own apply, never the apply"
  exit 2
fi

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

# The database the PostgREST installer reaches: the region's, unless a mode
# below points the steps at another database on the instance.
TARGET_URL="$DATABASE_URL"

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
CHANGED=0

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
    elif [ -n "$have" ]; then echo "  step $id: changed (applied, but its files have changed since)"; CHANGED=$((CHANGED + 1))
    else echo "  step $id: pending (not applied)"; PENDING=$((PENDING + 1)); fi
    return 0
  fi
  if [ "$#" -gt 0 ]; then "$@"; else "${PSQL[@]}" -f "${files[0]}"; fi
  record "$id" "$sum"
  if [ "$have" = "$sum" ]; then echo "  step $id: re-applied (files unchanged)"; else echo "  step $id: applied"; fi
}

postgrest_install() {
  BACKENLY_DB_ADMIN=url BACKENLY_ADMIN_DATABASE_URL="$TARGET_URL" bash "$ROOT/scripts/postgrest-install.sh"
}

# The PostgREST step's files: the installer, and every file it reads.
POSTGREST_FILES="$ROOT/scripts/postgrest-install.sh|$ROOT/scripts/lib/db-admin.sh|$ROOT/scripts/sql/postgrest-schema-registry.sql|$ROOT/scripts/sql/postgrest-ddl-sync.sql|$ROOT/scripts/sql/function-roles.sql"

# Which login roles have the password this procedure set: what a launcher needs
# to know before deciding which verifiers to compute (sql/roles.sql).
credentials() {
  local join="SELECT NULL::timestamptz AS set_at"
  if relation_exists backenly_meta.bootstrap_credentials; then
    join="SELECT b.set_at FROM backenly_meta.bootstrap_credentials b WHERE b.role_name = v.role_name"
  fi
  "${PSQL[@]}" -tA -c "
    SELECT '  credential ' || v.role_name || ': ' || CASE
             WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v.role_name) AND v.optional
               THEN 'missing (an apply makes it only when given ' || v.variable || ')'
             WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v.role_name)
               THEN 'missing (the first apply must supply ' || v.variable || ')'
             WHEN c.set_at IS NULL
               THEN 'unrecorded (exists, but this procedure never set its password)'
             ELSE 'recorded ' || to_char(c.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
           END
      FROM (VALUES ('backenly_app', 'BACKENLY_APP_VERIFIER', false),
                   ('backenly_backup', 'BACKENLY_BACKUP_VERIFIER', false),
                   ('backenly_authenticator', 'BACKENLY_AUTHENTICATOR_VERIFIER', false),
                   ('backenly_dbcreator', 'BACKENLY_DBCREATOR_VERIFIER', true)) AS v(role_name, variable, optional)
      LEFT JOIN LATERAL ($join) c ON true
     ORDER BY 1"
}

# ── A project's own database ─────────────────────────────────────────────────
# What the template, and every database cloned from it, is made of, in order.
# Each is idempotent and one transaction, as the region's steps are, and is
# recorded in the database's own ledger. A clone inherits the template's
# ledger, so it starts out recorded at the version it was cloned from.
TEMPLATE=backenly_project_template
PROJECT_STEPS=(project-db postgrest drift-events direct-access extensions)

project_step_files() {
  case "$1" in
    project-db) printf '%s' "$HERE/sql/project-db.sql" ;;
    postgrest) printf '%s' "$POSTGREST_FILES" ;;
    drift-events) printf '%s' "$ROOT/scripts/sql/schema-drift-events.sql" ;;
    direct-access) printf '%s' "$ROOT/scripts/setup-direct-access.sql" ;;
    extensions) printf '%s' "$HERE/sql/extensions.sql" ;;
    *) echo "no project step $1" >&2; return 1 ;;
  esac
}

# Apply one project step to the database PSQL and TARGET_URL name.
run_project_step() {
  if [ "$1" = postgrest ]; then
    postgrest_install
  else
    local file; file="$(project_step_files "$1")" || return 1
    "${PSQL[@]}" -f "$file"
  fi
}

# Point psql and the PostgREST installer at another database on the instance:
# DATABASE_URL with that database's name in place of the region's, so the same
# server, administrator and connection options.
use_database() {
  local base="${DATABASE_URL%%\?*}" query=""
  case "$DATABASE_URL" in *\?*) query="?${DATABASE_URL#*\?}" ;; esac
  TARGET_URL="${base%/*}/$1$query"
  PSQL=(psql -X -q -v ON_ERROR_STOP=1 -v allow_missing_extensions="$REHEARSAL" -d "$TARGET_URL")
}

# The project modes reach other databases by name from DATABASE_URL, so it must
# be a URL that names one; and they rely on the roles the region's apply makes,
# from this image's roles.sql (the role-level settings a clone needs among them).
require_region_applied() {
  local base="${DATABASE_URL%%\?*}"
  case "$base" in
    *://*/?*) ;;
    *) echo "refusing: BOOTSTRAP_MODE=$MODE needs DATABASE_URL as a postgresql:// URL that names the region's database"; exit 2 ;;
  esac
  local have; have="$(recorded roles)"
  if [ -z "$have" ]; then
    echo "refusing: the region's database has never applied sql/roles.sql. Run BOOTSTRAP_MODE=apply first: project databases use the roles it makes."
    exit 2
  elif [ "$have" != "$(checksum "$HERE/sql/roles.sql")" ]; then
    echo "refusing: the region's database applied another version of sql/roles.sql than this image's. Run BOOTSTRAP_MODE=apply first: project databases use the roles it makes."
    exit 2
  fi
}

# The template: created by the administrator if missing, closed to cloning while
# it converges (a database that is not a template may be cloned only by its
# owner or a superuser, so the creator role cannot copy it half-made), every
# step applied as an apply applies the region's, verified, then a template again
# and closed to connections, which cloning requires. A run that fails leaves it
# closed to both, so nothing is cloned from it until a run succeeds.
template_mode() {
  require_region_applied
  local -a control=("${PSQL[@]}")
  if [ "$("${control[@]}" -tA -c "SELECT count(*) FROM pg_database WHERE datname = '$TEMPLATE'")" = 0 ]; then
    "${control[@]}" -c "CREATE DATABASE $TEMPLATE TEMPLATE template0"
    echo "  template $TEMPLATE: created"
  else
    echo "  template $TEMPLATE: exists"
  fi
  "${control[@]}" -c "ALTER DATABASE $TEMPLATE WITH IS_TEMPLATE false ALLOW_CONNECTIONS true"
  CONTROL_PSQL=("${control[@]}")
  trap template_not_converged EXIT

  use_database "$TEMPLATE"
  "${PSQL[@]}" -f "$HERE/sql/ledger.sql"
  local id
  for id in "${PROJECT_STEPS[@]}"; do
    if [ "$id" = postgrest ]; then
      step "$id" "$(project_step_files "$id")" postgrest_install
    else
      step "$id" "$(project_step_files "$id")"
    fi
  done
  "${PSQL[@]}" -f "$HERE/sql/verify-project-db.sql"

  trap - EXIT
  "${control[@]}" -c "ALTER DATABASE $TEMPLATE WITH IS_TEMPLATE true ALLOW_CONNECTIONS false"
  echo "Project database template converged and verified: $TEMPLATE may be cloned."
}

template_not_converged() {
  local status=$?
  "${CONTROL_PSQL[@]}" -c "ALTER DATABASE $TEMPLATE WITH ALLOW_CONNECTIONS false" || true
  echo "Project database template NOT converged: nothing can be cloned from $TEMPLATE until a template run succeeds."
  exit "$status"
}

# Its recorded steps, "<step> <checksum>" per line, or nothing without a ledger.
project_ledger() {
  local present
  present="$("${PSQL[@]}" -tA -c "SELECT to_regclass('backenly_meta.bootstrap_steps') IS NOT NULL")" || return 1
  [ "$present" = t ] || return 0
  "${PSQL[@]}" -tA -F ' ' -c "SELECT step, checksum FROM backenly_meta.bootstrap_steps"
}

# One project database: the steps whose files changed since it recorded them
# (or that it never recorded), in order, then verification. Prints exactly one
# line that starts with "db ". Every command is checked here, rather than left
# to errexit, so the line names what failed.
converge_project_db() {
  local name="$1" ledger id sum have
  local -a applied=()
  use_database "$name"
  if ! ledger="$(project_ledger)"; then echo "db $name: failed connect"; return 1; fi
  for id in "${PROJECT_STEPS[@]}"; do
    sum="${PROJECT_SUMS[$id]}"
    have="$(printf '%s\n' "$ledger" | awk -v s="$id" '$1 == s { print $2 }')"
    if [ "$have" = "$sum" ]; then continue; fi
    if [ "${#applied[@]}" -eq 0 ]; then
      "${PSQL[@]}" -f "$HERE/sql/ledger.sql" || { echo "db $name: failed ledger"; return 1; }
    fi
    run_project_step "$id" || { echo "db $name: failed $id"; return 1; }
    record "$id" "$sum" >/dev/null || { echo "db $name: failed $id"; return 1; }
    applied+=("$id")
  done
  "${PSQL[@]}" -f "$HERE/sql/verify-project-db.sql" || { echo "db $name: failed verify"; return 1; }
  if [ "${#applied[@]}" -eq 0 ]; then
    echo "db $name: current"
  else
    echo "db $name: applied $(IFS=,; echo "${applied[*]}")"
  fi
}

# Lines, one per argument, and nothing at all for none (printf alone prints an
# empty line for no arguments).
lines() { if [ "$#" -gt 0 ]; then printf '%s\n' "$@"; fi; }

# Every database named p_<32 lowercase hex> on the instance, checked against
# the list the platform passed, then converged a few at a time. One database
# failing does not stop the others; the run fails if any did.
project_dbs_mode() {
  require_region_applied
  if [ -z "${BOOTSTRAP_PROJECT_DATABASES+x}" ] || [ -z "$BOOTSTRAP_PROJECT_DATABASES" ]; then
    echo "refusing: BOOTSTRAP_PROJECT_DATABASES must list the project databases the platform knows in this region (none, the names, or sha256:<hex>)"
    exit 2
  fi
  local parallel="${BOOTSTRAP_PARALLELISM:-3}"
  if ! [[ "$parallel" =~ ^[1-4]$ ]]; then
    echo "refusing: BOOTSTRAP_PARALLELISM must be 1 to 4, not \"$parallel\""
    exit 2
  fi

  local listing name
  local -a found=() expected=()
  listing="$("${PSQL[@]}" -tA -c "SELECT datname FROM pg_database WHERE datname ~ '^p_[0-9a-f]{32}\$' ORDER BY 1")"
  if [ -n "$listing" ]; then mapfile -t found <<< "$listing"; fi

  case "$BOOTSTRAP_PROJECT_DATABASES" in
    none) ;;
    sha256:*)
      local actual; actual="sha256:$(lines "${found[@]}" | sha256sum | cut -d' ' -f1)"
      if [ "$actual" != "$BOOTSTRAP_PROJECT_DATABASES" ]; then
        echo "refusing: the ${#found[@]} project database(s) found here hash to $actual, not to the list passed ($BOOTSTRAP_PROJECT_DATABASES). Nothing was touched."
        exit 2
      fi
      expected=("${found[@]}")
      ;;
    *)
      mapfile -t expected < <(printf '%s\n' "$BOOTSTRAP_PROJECT_DATABASES" | tr ', \t' '\n\n\n' | grep -v '^$' | LC_ALL=C sort -u)
      for name in "${expected[@]}"; do
        if ! [[ "$name" =~ ^p_[0-9a-f]{32}$ ]]; then
          echo "refusing: \"$name\" in BOOTSTRAP_PROJECT_DATABASES is not a project database name (p_<32 lowercase hex>)"
          exit 2
        fi
      done
      ;;
  esac
  local missing unexpected
  missing="$(LC_ALL=C comm -23 <(lines "${expected[@]}") <(lines "${found[@]}") | paste -sd' ' -)"
  unexpected="$(LC_ALL=C comm -13 <(lines "${expected[@]}") <(lines "${found[@]}") | paste -sd' ' -)"
  if [ -n "$missing" ] || [ -n "$unexpected" ]; then
    echo "refusing: the project databases found here are not the ones the platform listed. Nothing was touched."
    [ -z "$missing" ] || echo "  listed, not found: $missing"
    [ -z "$unexpected" ] || echo "  found, not listed: $unexpected"
    exit 2
  fi
  echo "  ${#found[@]} project database(s), as listed; converging $parallel at a time"

  declare -gA PROJECT_SUMS=()
  local id
  local -a files
  for id in "${PROJECT_STEPS[@]}"; do
    IFS='|' read -r -a files <<< "$(project_step_files "$id")"
    PROJECT_SUMS[$id]="$(checksum "${files[@]}")"
  done

  local running=0
  PROJECT_WORK="$(mktemp -d)"
  trap 'rm -rf "$PROJECT_WORK"' EXIT
  local work="$PROJECT_WORK"
  for name in "${found[@]}"; do
    ( converge_project_db "$name" ) > "$work/$name.log" 2>&1 &
    running=$((running + 1))
    if [ "$running" -ge "$parallel" ]; then
      wait -n || true
      running=$((running - 1))
    fi
  done
  wait || true

  local line current=0 changed=0 failed=0
  for name in "${found[@]}"; do
    line="$(grep -E "^db $name: " "$work/$name.log" | tail -n 1 || true)"
    [ -n "$line" ] || line="db $name: failed unknown"
    echo "$line"
    case "$line" in
      "db $name: current") current=$((current + 1)) ;;
      "db $name: applied "*) changed=$((changed + 1)) ;;
      *)
        failed=$((failed + 1))
        grep -vE '^db ' "$work/$name.log" | sed 's/^/    /' || true
        ;;
    esac
  done
  if [ "$failed" -gt 0 ]; then
    echo "Project databases: $current current, $changed applied, $failed failed. The run fails: every database must verify."
    return 1
  fi
  echo "Project databases converged and verified: $current current, $changed applied, 0 failed."
}

if [ "$MODE" = template ] || [ "$MODE" = project-dbs ]; then
  echo
  if [ "$MODE" = template ]; then echo "Project database template ($MODE)"; else echo "Project databases ($MODE)"; fi
  # Preflight on the region's database: the server, and that this is the region's.
  "${PSQL[@]}" -f "$HERE/sql/preflight.sql"
  if [ "$MODE" = template ]; then template_mode; else project_dbs_mode; fi
  exit 0
fi

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
export BACKENLY_DBCREATOR_VERIFIER="${BACKENLY_DBCREATOR_VERIFIER:-}"
export BOOTSTRAP_ROTATE="${BOOTSTRAP_ROTATE:-}"

# 1. Roles first: the PostgREST files grant to public.backenly_app_role(), which
#    must already resolve to the application role rather than to the installer.
step roles "$HERE/sql/roles.sql"
# 2. The PostgREST registry, DDL sync and function roles, in their own order.
step postgrest "$POSTGREST_FILES" postgrest_install
# 3. The one platform-shaped table a regional database holds, before the capture
#    triggers that write it.
step drift-events "$ROOT/scripts/sql/schema-drift-events.sql"
# 4. The region's projects' customer data on platform rows, which never
#    leaves the region (lib/data-plane/regional-bodies.ts).
step regional-bodies "$ROOT/scripts/sql/regional-bodies.sql"
# 5. The region's copy of what authorizes its projects' requests, delivered
#    from the home region (lib/auth-projection/deliver.ts).
step auth-projection "$ROOT/scripts/sql/auth-projection.sql"
# 6. Direct database access and its two DDL-capture event triggers. Each apply
#    also takes from every read-write login any way to change the schema, since
#    a region's database is shared by its projects (the file's section 7), and
#    gives the backup role read on every workspace that already exists (section
#    8); verify.sql then requires both.
step direct-access "$ROOT/scripts/setup-direct-access.sql"
# 7. Extensions the data plane and its probes use.
step extensions "$HERE/sql/extensions.sql"

credentials

# Verification fails the run when the database is not what the steps promise.
# It is read-only, so a check runs it too once every step is recorded: that is
# how a live region is audited, and a check that does not verify fails.
#
# One check may pass without verifying: the one a launcher runs just before its
# own apply (BOOTSTRAP_PRE_APPLY=true, launch.ts), when steps changed since they
# were applied. What they now promise is exactly what that apply converges, and
# the apply then fails the run if the database still does not verify. Failing
# here would refuse the one run that converges it. Every other check, and a
# pre-apply check whose steps are all current, fails on what does not verify.
if [ "$APPLY" = true ]; then
  "${PSQL[@]}" -f "$HERE/sql/verify.sql"
  echo "Regional database initialised and verified."
elif [ "$PENDING" -gt 0 ]; then
  echo "Check only: nothing was written. $PENDING step(s) not applied yet."
elif [ "$CHANGED" -eq 0 ]; then
  "${PSQL[@]}" -f "$HERE/sql/verify.sql"
  echo "Check only: nothing was written. Every step is recorded, and the database verifies."
else
  verified=0
  "${PSQL[@]}" -f "$HERE/sql/verify.sql" || verified=$?
  if [ "$verified" -eq 0 ]; then
    echo "Check only: nothing was written. $CHANGED step(s) changed since applied, and the database verifies."
  elif [ "$PRE_APPLY" = true ]; then
    echo "Check only: nothing was written. $CHANGED step(s) changed since applied: the apply that follows converges what does not verify."
  else
    echo "Check only: nothing was written. $CHANGED step(s) changed since applied, and the database does not verify."
    exit "$verified"
  fi
fi
