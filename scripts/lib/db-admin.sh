#!/usr/bin/env bash
# ============================================================================
# ONE WAY TO RUN PRIVILEGED SQL, WHEREVER THE DATABASE LIVES
# ============================================================================
# Sourced by the setup scripts. Never executed directly.
#
# The scripts used to hardcode `sudo -u postgres psql -f <file>`, which assumes
# three things at once: PostgreSQL is on this host, an OS user named `postgres`
# exists, and psql is installed here. The documented quickstart runs PostgreSQL
# in Docker, where none of those hold, so the primary path could not complete
# its own prerequisite step. A managed or remote database fails the same way.
#
# Worse, `-f <file>` makes the DATABASE's user open the file. On Ubuntu, home
# directories are 0750 (`HOME_MODE` in /etc/login.defs), so `postgres` cannot
# traverse into /home/<user>, and a normal clone under the operator's home
# failed with:
#
#     psql: error: /home/ubuntu/backenly/scripts/sql/...sql: Permission denied
#
# Found on a clean Ubuntu 24.04 acceptance machine, on the documented path.
#
# Both problems have the same fix: the file is redirected on stdin, so the
# OPERATOR'S shell opens it and psql only ever reads a stream. That works under
# any home permissions, and in docker mode it means the SQL does not need to
# exist inside the container at all.
#
# The mode is chosen explicitly rather than sniffed, because guessing wrong here
# means running privileged DDL against the wrong database.
#
#   BACKENLY_DB_ADMIN=docker   (default) psql inside the Compose postgres service
#   BACKENLY_DB_ADMIN=url      psql against BACKENLY_ADMIN_DATABASE_URL
#   BACKENLY_DB_ADMIN=local    sudo -u postgres psql, for a local cluster
#
# All three must reach the database as a SUPERUSER: the registry writes
# role-level settings and event triggers, neither of which a normal role may do.

BACKENLY_DB_ADMIN="${BACKENLY_DB_ADMIN:-docker}"
BACKENLY_COMPOSE_FILE="${BACKENLY_COMPOSE_FILE:-docker-compose.dev.yml}"
BACKENLY_POSTGRES_SERVICE="${BACKENLY_POSTGRES_SERVICE:-postgres}"
BACKENLY_DB="${PGDATABASE:-${POSTGRES_DB:-backenly}}"
BACKENLY_DB_SUPERUSER="${POSTGRES_USER:-backenly_user}"

db_admin_describe() {
  case "$BACKENLY_DB_ADMIN" in
    docker) echo "docker compose exec ${BACKENLY_POSTGRES_SERVICE} (db ${BACKENLY_DB})" ;;
    url)    echo "BACKENLY_ADMIN_DATABASE_URL" ;;
    local)  echo "sudo -u postgres (db ${BACKENLY_DB})" ;;
    *)      echo "unknown" ;;
  esac
}

db_admin_check() {
  case "$BACKENLY_DB_ADMIN" in
    docker)
      if ! command -v docker >/dev/null 2>&1; then
        echo "BACKENLY_DB_ADMIN=docker but docker is not installed." >&2
        db_admin_modes >&2
        return 1
      fi
      ;;
    url)
      if [ -z "${BACKENLY_ADMIN_DATABASE_URL:-}" ]; then
        echo "BACKENLY_DB_ADMIN=url but BACKENLY_ADMIN_DATABASE_URL is not set." >&2
        echo "  It must name a SUPERUSER, e.g." >&2
        echo "    export BACKENLY_ADMIN_DATABASE_URL=postgresql://postgres:pw@host:5432/backenly" >&2
        return 1
      fi
      if ! command -v psql >/dev/null 2>&1; then
        echo "BACKENLY_DB_ADMIN=url but psql is not installed on this host." >&2
        return 1
      fi
      ;;
    local)
      if ! id postgres >/dev/null 2>&1; then
        echo "BACKENLY_DB_ADMIN=local but there is no 'postgres' OS user on this host." >&2
        echo "  That mode is only for a PostgreSQL installed on this machine." >&2
        db_admin_modes >&2
        return 1
      fi
      ;;
    *)
      echo "BACKENLY_DB_ADMIN='${BACKENLY_DB_ADMIN}' is not a known mode." >&2
      db_admin_modes >&2
      return 1
      ;;
  esac
}

db_admin_modes() {
  echo "  Choose one explicitly:"
  echo "    BACKENLY_DB_ADMIN=docker   psql inside the Compose postgres service (default)"
  echo "    BACKENLY_DB_ADMIN=url      psql against BACKENLY_ADMIN_DATABASE_URL"
  echo "    BACKENLY_DB_ADMIN=local    sudo -u postgres psql, for a local cluster"
}

# Run psql with the caller's arguments. Stdin is passed straight through, which
# is what lets db_admin_sql_file hand over a file the database user cannot open.
db_admin_psql() {
  case "$BACKENLY_DB_ADMIN" in
    docker)
      docker compose -f "$BACKENLY_COMPOSE_FILE" exec -T "$BACKENLY_POSTGRES_SERVICE" \
        psql -U "$BACKENLY_DB_SUPERUSER" -d "$BACKENLY_DB" "$@"
      ;;
    url)
      psql "$BACKENLY_ADMIN_DATABASE_URL" "$@"
      ;;
    local)
      sudo -u postgres psql -d "$BACKENLY_DB" "$@"
      ;;
  esac
}

# Install a .sql file.
#
# `-f -` and the redirect are the whole point, and must not be "simplified" back
# to `-f "$file"`: the redirect is performed by THIS shell, running as the
# operator, so the file is opened by someone who can actually read it. See the
# header, and __tests__/setup/sql-file-access.test.ts, which reproduces the
# original failure by reverting exactly this line.
db_admin_sql_file() {
  local file="$1"
  [ -r "$file" ] || { echo "  cannot read $file" >&2; return 1; }
  # ON_ERROR_STOP is load-bearing: without it psql reports failures on stderr
  # and still exits 0, so a broken install looks like a successful one and the
  # first symptom is a missing trigger during an outage.
  db_admin_psql -v ON_ERROR_STOP=1 -q -f - < "$file"
}
