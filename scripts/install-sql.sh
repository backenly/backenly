#!/usr/bin/env bash
#
# Install one .sql file into the Backenly database as a superuser.
#
# Exists so that the prerequisite bootstrap prints is a single command that
# works whether PostgreSQL is in Docker, remote, or on this host. It used to
# print `psql -d <database> -f scripts/setup-direct-access.sql`, which quietly
# assumed a local cluster; run the obvious way, as
# `sudo -u postgres psql -f ...`, it failed outright under Ubuntu's default 0750
# home directories because the postgres user cannot traverse /home/<user>.
#
#   bash scripts/install-sql.sh scripts/setup-direct-access.sql
#
# Mode is selected exactly as in scripts/postgrest-install.sh:
#   BACKENLY_DB_ADMIN=docker|url|local   (default docker)
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/db-admin.sh
. "$DIR/lib/db-admin.sh"

if [ $# -ne 1 ]; then
  echo "usage: bash scripts/install-sql.sh <file.sql>" >&2
  db_admin_modes >&2
  exit 2
fi

FILE="$1"
[ -r "$FILE" ] || { echo "cannot read $FILE" >&2; exit 1; }

db_admin_check

echo "Installing $(basename "$FILE") via $(db_admin_describe)"
db_admin_sql_file "$FILE"
echo "  done."
