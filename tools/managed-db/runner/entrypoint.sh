#!/bin/sh
# The migration runner's entire surface.
#
# Two steady-state commands, plus two one-time repairs to migration history:
# `baseline` (resolve --applied) for an existing database, and `rollback`
# (resolve --rolled-back) for a migration that failed. Neither is part of a
# normal deploy, so each needs an explicit confirmation naming the exact
# migration, and a routine release can never rewrite history by accident.
set -eu

# Fixed paths in the image. The overrides exist for the test harness, which runs
# this script against a real database with the repository's Prisma CLI. No
# launcher sets them.
PRISMA="${MIGRATE_PRISMA:-/app/node_modules/.bin/prisma}"
SCHEMA="${MIGRATE_SCHEMA:-/app/prisma/schema.prisma}"
CHECKS="${MIGRATE_CHECKS:-/app/checks}"

# One catalog check from $CHECKS, which fails with the check's own message.
run_check() {
  "$PRISMA" db execute --schema "$SCHEMA" --file "$CHECKS/$1"
}

# Can this credential alter everything a migration may alter? Asked BEFORE
# `migrate deploy`, because Prisma writes a failed history row the moment a
# migration statement fails, and that row refuses every later deploy until it is
# resolved. A refusal here leaves the database and its history untouched.
preflight() {
  if ! run_check ownership-preflight.sql; then
    echo "refusing: ownership preflight failed; nothing was applied and no migration history was written"
    exit 3
  fi
  echo "PREFLIGHT PASSED: the migration role can alter every migration-managed object"
}

# Which database did we actually connect to?
#
# The launcher checks that the secret ARN names a production resource, but that
# is a check on a pointer. This is the check on the connection: when
# EXPECT_DATABASE is set, the URL's database must be that one or nothing runs.
# It matters most for `baseline`, which writes migration history into whatever
# it reaches, and where reaching the wrong database is not recoverable by
# re-running.
#
# Parsed after the LAST '@' so a password containing '/' cannot shift the
# fields. If there is no path at all the extraction yields host:port, which
# matches nothing and refuses — the failure direction we want.
if [ -n "${EXPECT_DATABASE:-}" ]; then
  [ -n "${DATABASE_URL:-}" ] || { echo "refusing: EXPECT_DATABASE is set but DATABASE_URL is empty"; exit 2; }
  _rest=${DATABASE_URL##*@}
  _path=${_rest#*/}
  _db=${_path%%\?*}
  if [ "$_db" != "$EXPECT_DATABASE" ]; then
    echo "refusing: connected database is \"$_db\", expected \"$EXPECT_DATABASE\""
    exit 2
  fi
  echo "database: $_db (matches EXPECT_DATABASE)"
fi

case "${1:-}" in
  status)
    exec "$PRISMA" migrate status --schema "$SCHEMA"
    ;;
  deploy)
    preflight
    exec "$PRISMA" migrate deploy --schema "$SCHEMA"
    ;;
  preflight)
    # The same check deploy runs first, on its own, so an operator can prove a
    # database is ready before a release rather than finding out during one.
    preflight
    ;;
  rollback)
    # Mark a FAILED migration as rolled back, so the next deploy retries it.
    #
    # Prisma refuses every deploy while a failed row is in _prisma_migrations.
    # Resolving it asserts that the attempt left nothing behind, which is only
    # true if it has been checked. So each migration this may resolve has an
    # absence proof of its own, the resolve runs only when that proof passes,
    # and a migration without one is refused. Prisma adds the last check: it
    # refuses to roll back a migration that is not in a failed state.
    #
    # Afterwards `status` is NOT evidence. Measured with Prisma 5.22: once the
    # row is marked rolled back, `migrate status` prints "Database schema is up
    # to date!" although the migration is unapplied, and `deploy` applies it.
    # `verify <id>` failing, then the deploy's "Applying migration" line, are.
    MIGRATION="${2:-}"
    [ -n "$MIGRATION" ] || { echo "rollback needs a migration id"; exit 2; }
    if [ "${MIGRATE_ROLLBACK_CONFIRM:-}" != "$MIGRATION" ]; then
      echo "refusing: rollback needs MIGRATE_ROLLBACK_CONFIRM to name the same migration"
      exit 2
    fi
    case "$MIGRATION" in
      20260924120000_project_pause) ;;
      *)
        echo "refusing: no absence proof is defined for \"$MIGRATION\", so it cannot be resolved as rolled back"
        exit 2
        ;;
    esac
    if ! run_check "$MIGRATION.absent.sql"; then
      echo "refusing: the failed attempt left effects of $MIGRATION behind; investigate before resolving anything"
      exit 3
    fi
    echo "ABSENT: $MIGRATION left none of its declared effects behind"
    exec "$PRISMA" migrate resolve --rolled-back "$MIGRATION" --schema "$SCHEMA"
    ;;
  baseline)
    MIGRATION="${2:-}"
    [ -n "$MIGRATION" ] || { echo "baseline needs a migration id"; exit 2; }
    if [ "${MIGRATE_BASELINE_CONFIRM:-}" != "$MIGRATION" ]; then
      echo "refusing: baselining needs MIGRATE_BASELINE_CONFIRM to name the same migration"
      exit 2
    fi
    exec "$PRISMA" migrate resolve --applied "$MIGRATION" --schema "$SCHEMA"
    ;;
  verify)
    # Did the objects a migration DECLARES actually land?
    #
    # `migrate status` reports that a migration ran, which is a statement about
    # the history table, not about the schema. These are the objects
    # themselves, read from the catalog, with the expected set fixed HERE. No
    # SQL crosses the boundary: this takes a migration id and nothing else, so
    # it cannot become a query surface on a production database.
    MIGRATION="${2:-}"
    [ -n "$MIGRATION" ] || { echo "verify needs a migration id"; exit 2; }
    case "$MIGRATION" in
      20260916180000_maintenance_approvals)
        # Not exec'd: the marker below has to be printed AFTER the script
        # succeeds. "Script executed successfully" is prisma's own wording for
        # "the statements ran", and a caller cannot tell from it whether this
        # particular assertion was the thing that ran.
        "$PRISMA" db execute --schema "$SCHEMA" --stdin <<'SQL'
DO $$
DECLARE missing text := '';
BEGIN
  IF to_regclass('public.maintenance_approvals') IS NULL THEN
    missing := missing || ' table:maintenance_approvals';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public'
                    AND indexname='maintenance_approvals_planId_planVersion_key') THEN
    missing := missing || ' index:planId_planVersion_key';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public'
                    AND indexname='maintenance_approvals_projectId_revokedAt_idx') THEN
    missing := missing || ' index:projectId_revokedAt_idx';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='maintenance_approvals_projectId_fkey' AND contype='f') THEN
    missing := missing || ' fk:projectId_fkey';
  END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION 'migration 20260916180000 declared objects that are absent:%', missing;
  END IF;
  RAISE NOTICE 'verified: table, both indexes and the foreign key are present';
END $$;
SQL
        echo "VERIFIED: $MIGRATION declared objects are all present"
        ;;
      20260924120000_project_pause)
        run_check "$MIGRATION.present.sql"
        echo "VERIFIED: $MIGRATION declared objects are all present"
        ;;
      *)
        echo "refusing: no verification is defined for \"$MIGRATION\""
        exit 2
        ;;
    esac
    ;;
  *)
    echo "usage: status | deploy | preflight | baseline <migration-id> | rollback <migration-id> | verify <migration-id>"
    exit 2
    ;;
esac
