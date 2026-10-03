#!/usr/bin/env bash
# ============================================================================
# START THE NEXT STANDALONE SERVER WITH ITS ENVIRONMENT ALREADY IN PLACE
# ============================================================================
#
# The Next standalone server changes its working directory to the directory
# holding server.js before it does anything else. Any environment it loads for
# itself is therefore resolved relative to `.next/standalone/`, NOT the app
# root — so a perfectly correct `.env` sitting next to package.json is invisible
# to it.
#
# That took production down on 2026-09-06. The release was built off-host, so
# the artifact deliberately contained no secrets; the app root had the real
# `.env`; and every page still returned 500:
#
#   Error: An error occurred while loading instrumentation hook:
#          JWT_SECRET environment variable is not set
#
# because lib/auth/jwt.ts reads process.env at module scope and Next executes
# route modules during page-data collection. The stop-gap was to copy `.env`
# into `.next/standalone/`, which works but makes a build artifact the home of
# production secrets and silently reintroduces the same outage on the next
# deploy, since deploy.sh renames a fresh `.next.staging` over `.next` and the
# copy disappears with the old tree.
#
# This wrapper fixes the contract instead of the symptom: it puts the variables
# into the PROCESS ENVIRONMENT and then execs node. Once the environment is
# inherited, what server.js does with chdir() afterwards cannot matter.
#
#   root .env  ->  this wrapper  ->  exec node .next/standalone/server.js
#
# NOT the secret-delivery mechanism for containers. On ECS the task definition
# and Secrets Manager populate the environment before the process starts, which
# is the same property arrived at properly. This exists for Hetzner and for any
# other bare-host deployment.
#
# USAGE
#
#   scripts/start-next-standalone.sh [entry]
#
#   entry   server entry point to exec (default: .next/standalone/server.js).
#           Passing it explicitly is what lets the regression test observe the
#           delivered environment without building Next.
#
# ENVIRONMENT
#
#   BACKENLY_ENV_FILE   environment file to load (default: <app root>/.env)
#
# Values are never printed: a deploy log is not a place for secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${BACKENLY_ENV_FILE:-$ROOT/.env}"
ENTRY="${1:-$ROOT/.next/standalone/server.js}"

if [ ! -f "$ENV_FILE" ]; then
  echo "start-next-standalone: FATAL: no environment file at $ENV_FILE" >&2
  echo "  The standalone server cannot read the app root .env for itself, so" >&2
  echo "  this wrapper must load it. Refusing to start a process that would" >&2
  echo "  come up without JWT_SECRET, DATABASE_URL or BACKENLY_EDITION." >&2
  exit 1
fi

# Parse rather than source. `. .env` would let a value containing $(...) or
# backticks execute as this script's user, and would choke on any value holding
# a space. Assigning through `export "name=value"` passes the value as a single
# word: no expansion, no word splitting, no evaluation.
line_no=0
loaded=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))

  # Blank lines, comments, and `export FOO=bar` written by hand.
  case "$line" in
    ''|'#'*) continue ;;
    'export '*) line="${line#export }" ;;
  esac

  # Must look like an assignment to a valid shell name.
  case "$line" in
    *=*) ;;
    *)
      echo "start-next-standalone: FATAL: malformed entry at $ENV_FILE:$line_no (no '=')" >&2
      exit 1
      ;;
  esac

  name="${line%%=*}"
  value="${line#*=}"

  if ! printf '%s' "$name" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
    echo "start-next-standalone: FATAL: invalid variable name at $ENV_FILE:$line_no" >&2
    exit 1
  fi

  # Strip one matching pair of surrounding quotes, the way dotenv does, so the
  # runtime process (which uses dotenv) and this wrapper agree byte for byte.
  # An unbalanced quote means a multi-line value this parser would silently
  # truncate — refuse rather than hand Node half a secret.
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
    \"*|\'*)
      echo "start-next-standalone: FATAL: unterminated quote at $ENV_FILE:$line_no" >&2
      echo "  Multi-line values are not supported here. Refusing to truncate." >&2
      exit 1
      ;;
  esac

  export "$name=$value"
  loaded=$((loaded + 1))
done < "$ENV_FILE"

if [ ! -f "$ENTRY" ]; then
  echo "start-next-standalone: FATAL: entry not found: $ENTRY" >&2
  exit 1
fi

# Names only. A deploy log must never carry values.
echo "start-next-standalone: loaded $loaded variable(s) from $ENV_FILE"
echo "start-next-standalone: exec node $ENTRY"

# exec, so node REPLACES this shell. PM2 then supervises node itself and its
# signals reach node directly; a lingering wrapper process would absorb SIGINT
# and turn a graceful shutdown into a kill.
exec node "$ENTRY"
