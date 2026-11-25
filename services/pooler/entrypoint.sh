#!/usr/bin/env bash
#
# THE CONNECTION POOLER'S ENTRYPOINT
# ==================================
# Renders PgBouncer's configuration from the environment and runs PgBouncer,
# one process per container. POOLER_MODE picks the pooling mode, and with it
# the default port: session on 5432, transaction on 6543.
# services/pooler/README.md describes every variable.
#
#   pooler-entrypoint            check the settings, write the configuration
#                                under /run/pooler/<mode>, run PgBouncer
#   pooler-entrypoint check      check the settings, print the pgbouncer.ini
#                                and pg_hba.conf that would run, keep no file
#   pooler-entrypoint databases  check the settings, print the [databases]
#                                list for the project database names on
#                                standard input, keep no file
#
# ONLY PROJECT DATABASES ARE SERVED. There is no "*" entry: PgBouncer knows
# exactly the databases named in /run/pooler/<mode>/databases.ini. A client
# asking for any other name gets a login that fails, decided inside PgBouncer
# (it runs no lookup and opens no server connection for it, and answers as it
# would a wrong password, so which databases exist is not revealed). The list
# is every existing p_<32 hex> database with an active login, read from
# backenly_pooler.databases() before PgBouncer starts and again every
# POOLER_DATABASE_REFRESH_SECONDS, and PgBouncer reloads it when it changes.
# Each listed database's auth_query names that database, so a login is checked
# only for its own project's database (tools/managed-db/regional/sql/pooler.sql).
# PgBouncer's pg_hba.conf has no pattern form and its auth_query sees only the
# user name, so an explicit list is the one way it can serve p_* names alone.
#
# A setting that is missing, empty, malformed or unknown stops the container
# with exit status 2 and one line saying which, before anything is written.
#
# Nothing printed holds a secret value. The certificate, its key, a server CA
# and the lookup role's password are written to files only this user can read
# (0600), and taken out of the environment before PgBouncer starts.
set -euo pipefail
umask 077
export LC_ALL=C

readonly AUTH_USER=backenly_pooler_auth
readonly AUTH_DB=backenly_pooler
readonly IMAGE_SERVER_CA=/etc/ssl/rds/rds-ca-cloud-regions.pem
readonly RUN_ROOT=/run/pooler
readonly PROJECT_DATABASE='^p_[0-9a-f]{32}$'

refuse() {
  printf 'pooler: refusing to start: %s\n' "$*" >&2
  exit 2
}

ACTION="${1:-run}"
[ "$#" -le 1 ] || refuse "expected no argument, check, or databases"
case "$ACTION" in
  run | check | databases) ;;
  *) refuse "expected no argument, check, or databases" ;;
esac

# ── Every POOLER_ variable is one this file reads ─────────────────────────────
# A misspelt setting would otherwise be ignored and its default used in silence.
readonly KNOWN=" POOLER_MODE POOLER_LISTEN_PORT POOLER_SERVER_HOST POOLER_SERVER_PORT \
POOLER_SERVER_TLS_MODE POOLER_SERVER_CA_PEM POOLER_TLS_CERT_PEM POOLER_TLS_KEY_PEM \
POOLER_AUTH_PASSWORD POOLER_MAX_CLIENT_CONN POOLER_DEFAULT_POOL_SIZE \
POOLER_MAX_DB_CONNECTIONS POOLER_MAX_DB_CLIENT_CONNECTIONS POOLER_QUERY_TIMEOUT \
POOLER_MAX_PREPARED_STATEMENTS POOLER_DATABASE_REFRESH_SECONDS "
while IFS= read -r name; do
  case "$KNOWN" in
    *" $name "*) ;;
    *) refuse "$name is not a setting the pooler reads (services/pooler/README.md lists them)" ;;
  esac
done < <(compgen -e | grep '^POOLER_' || true)

# required NAME: present and not empty.
required() {
  [ -n "${!1+x}" ] || refuse "$1 is not set"
  [ -n "${!1}" ] || refuse "$1 is set but empty"
}

# whole NAME DEFAULT MIN MAX: a whole number, the default when unset.
whole() {
  local name="$1" default="$2" min="$3" max="$4" value
  if [ -n "${!name+x}" ]; then value="${!name}"; else value="$default"; fi
  [[ "$value" =~ ^(0|[1-9][0-9]{0,8})$ ]] || refuse "$name must be a whole number, not \"$value\""
  ((value >= min && value <= max)) || refuse "$name must be from $min to $max, not $value"
  printf -v "$name" '%s' "$value"
}

# pem_to NAME FILE: a PEM value from the environment, written to FILE. Real
# newlines, or the two characters \n where a store kept the value on one line.
pem_to() {
  local value="${!1}"
  value="${value//$'\r'/}"
  if [[ "$value" != *$'\n'* && "$value" == *'\n'* ]]; then value="${value//\\n/$'\n'}"; fi
  printf '%s\n' "$value" >"$2"
}

# ── Mode and listener ─────────────────────────────────────────────────────────
required POOLER_MODE
case "$POOLER_MODE" in
  session) default_port=5432 ;;
  transaction) default_port=6543 ;;
  *) refuse "POOLER_MODE must be session or transaction, not \"$POOLER_MODE\"" ;;
esac
whole POOLER_LISTEN_PORT "$default_port" 1 65535

# ── The database server ───────────────────────────────────────────────────────
required POOLER_SERVER_HOST
if ! [[ "$POOLER_SERVER_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]]; then
  refuse "POOLER_SERVER_HOST must be a host name or an IPv4 address"
fi
whole POOLER_SERVER_PORT 5432 1 65535
POOLER_SERVER_TLS_MODE="${POOLER_SERVER_TLS_MODE-verify-full}"
case "$POOLER_SERVER_TLS_MODE" in
  verify-full | verify-ca | disable) ;;
  *) refuse "POOLER_SERVER_TLS_MODE must be verify-full, verify-ca or disable, not \"$POOLER_SERVER_TLS_MODE\"" ;;
esac
if [ "$POOLER_SERVER_TLS_MODE" = disable ] && [ -n "${POOLER_SERVER_CA_PEM+x}" ]; then
  refuse "POOLER_SERVER_CA_PEM is set, but POOLER_SERVER_TLS_MODE is disable"
fi
whole POOLER_DATABASE_REFRESH_SECONDS 10 1 3600

# ── Limits ────────────────────────────────────────────────────────────────────
whole POOLER_MAX_CLIENT_CONN 5000 1 100000
whole POOLER_DEFAULT_POOL_SIZE 5 1 1000
whole POOLER_MAX_DB_CONNECTIONS 10 1 10000
whole POOLER_MAX_DB_CLIENT_CONNECTIONS 0 0 100000
whole POOLER_QUERY_TIMEOUT 900 0 86400
whole POOLER_MAX_PREPARED_STATEMENTS 200 0 5000
((POOLER_MAX_DB_CONNECTIONS >= POOLER_DEFAULT_POOL_SIZE)) ||
  refuse "POOLER_MAX_DB_CONNECTIONS ($POOLER_MAX_DB_CONNECTIONS) is below POOLER_DEFAULT_POOL_SIZE ($POOLER_DEFAULT_POOL_SIZE), so no pool could ever fill"
if ((POOLER_MAX_DB_CLIENT_CONNECTIONS > 0 && POOLER_MAX_DB_CLIENT_CONNECTIONS < POOLER_MAX_DB_CONNECTIONS)); then
  refuse "POOLER_MAX_DB_CLIENT_CONNECTIONS ($POOLER_MAX_DB_CLIENT_CONNECTIONS) is below POOLER_MAX_DB_CONNECTIONS ($POOLER_MAX_DB_CONNECTIONS)"
fi
((POOLER_MAX_DB_CLIENT_CONNECTIONS <= POOLER_MAX_CLIENT_CONN)) ||
  refuse "POOLER_MAX_DB_CLIENT_CONNECTIONS ($POOLER_MAX_DB_CLIENT_CONNECTIONS) is above POOLER_MAX_CLIENT_CONN ($POOLER_MAX_CLIENT_CONN)"

# ── Secrets: presence and shape, never their values ───────────────────────────
required POOLER_TLS_CERT_PEM
required POOLER_TLS_KEY_PEM
required POOLER_AUTH_PASSWORD
if [ -n "${POOLER_SERVER_CA_PEM+x}" ]; then required POOLER_SERVER_CA_PEM; fi

# Written into PgBouncer's auth_file between double quotes, and hashed by
# PgBouncer for SCRAM exactly as PostgreSQL hashed it: ASCII, so neither side
# normalizes it, and no character the file format would need to escape.
password="$POOLER_AUTH_PASSWORD"
if ((${#password} < 16 || ${#password} > 1024)); then
  refuse "POOLER_AUTH_PASSWORD must be 16 to 1024 characters long"
fi
case "$password" in
  *[![:graph:]]* | *'"'* | *'\'*)
    refuse "POOLER_AUTH_PASSWORD may hold printable ASCII only, without spaces, double quotes or backslashes"
    ;;
esac

command -v openssl >/dev/null || refuse "openssl is not installed; it checks the certificate and key"
if [ "$ACTION" = run ]; then
  command -v psql >/dev/null || refuse "psql is not installed; it reads the project database list"
fi

CONF_DIR="$RUN_ROOT/$POOLER_MODE"
if [ "$ACTION" = run ]; then
  [ -d "$RUN_ROOT" ] && [ -w "$RUN_ROOT" ] ||
    refuse "$RUN_ROOT is not a writable directory (with a read-only root filesystem, mount a writable volume there)"
  rm -rf "$CONF_DIR"
  mkdir -m 0700 "$CONF_DIR"
  WORK="$CONF_DIR"
  # Any temporary file bash makes stays here too, so a read-only root needs
  # no writable /tmp.
  export TMPDIR="$CONF_DIR"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
fi

pem_to POOLER_TLS_CERT_PEM "$WORK/client-tls.crt"
pem_to POOLER_TLS_KEY_PEM "$WORK/client-tls.key"
openssl x509 -in "$WORK/client-tls.crt" -noout >/dev/null 2>&1 ||
  refuse "POOLER_TLS_CERT_PEM does not hold a PEM certificate"
openssl x509 -in "$WORK/client-tls.crt" -noout -checkend 0 >/dev/null 2>&1 ||
  refuse "the certificate in POOLER_TLS_CERT_PEM has expired"
openssl pkey -in "$WORK/client-tls.key" -noout -passin pass: >/dev/null 2>&1 ||
  refuse "POOLER_TLS_KEY_PEM does not hold an unencrypted PEM private key"
[ "$(openssl x509 -in "$WORK/client-tls.crt" -noout -pubkey 2>/dev/null)" = \
  "$(openssl pkey -in "$WORK/client-tls.key" -pubout -passin pass: 2>/dev/null)" ] ||
  refuse "the key in POOLER_TLS_KEY_PEM is not the key of the certificate in POOLER_TLS_CERT_PEM"

server_ca=""
if [ "$POOLER_SERVER_TLS_MODE" != disable ]; then
  if [ -n "${POOLER_SERVER_CA_PEM+x}" ]; then
    pem_to POOLER_SERVER_CA_PEM "$WORK/server-ca.pem"
    grep -q -- '-----BEGIN CERTIFICATE-----' "$WORK/server-ca.pem" &&
      { openssl crl2pkcs7 -nocrl -certfile "$WORK/server-ca.pem" | openssl pkcs7 -print_certs -noout; } >/dev/null 2>&1 ||
      refuse "POOLER_SERVER_CA_PEM does not hold PEM certificates"
    server_ca="$CONF_DIR/server-ca.pem"
  else
    [ -s "$IMAGE_SERVER_CA" ] ||
      refuse "$IMAGE_SERVER_CA is missing; outside the image, set POOLER_SERVER_CA_PEM"
    server_ca="$IMAGE_SERVER_CA"
  fi
fi

printf '"%s" "%s"\n' "$AUTH_USER" "$password" >"$WORK/userlist.txt"
# The same password for psql, which reads the project database list. In a
# password file ":" separates fields, so it is escaped.
printf '*:*:%s:%s:%s\n' "$AUTH_DB" "$AUTH_USER" "${password//:/\\:}" >"$WORK/pgpass"
unset password

# ── pgbouncer.ini ─────────────────────────────────────────────────────────────
render_ini() {
  cat <<EOF
;; Rendered by services/pooler/entrypoint.sh from the environment at start.
;; services/pooler/README.md explains every value.

[databases]
;; The lookup database, so PgBouncer can run auth_query. Clients asking for it
;; are turned away by pg_hba.conf. Project databases are listed in the file
;; included at the end; there is deliberately no "*" entry, so a login to any
;; other database name fails inside PgBouncer and never reaches the server.
${AUTH_DB} = host=${POOLER_SERVER_HOST} port=${POOLER_SERVER_PORT} dbname=${AUTH_DB}

[pgbouncer]
pool_mode = ${POOLER_MODE}
listen_addr = 0.0.0.0
listen_port = ${POOLER_LISTEN_PORT}
;; TCP only: no unix socket.
unix_socket_dir =

;; Logins: SCRAM-SHA-256 against the verifier backenly_pooler.lookup() returns
;; (tools/managed-db/regional/sql/pooler.sql), passed through to the server.
;; Each project database's own auth_query names it; this one, for anything
;; else, finds no login. pg_hba.conf turns away the lookup role, the lookup
;; database, replication and the console database. admin_users and
;; stats_users are deliberately not set, so no login may use the console.
auth_type = hba
auth_hba_file = ${CONF_DIR}/pg_hba.conf
auth_file = ${CONF_DIR}/userlist.txt
auth_user = ${AUTH_USER}
auth_dbname = ${AUTH_DB}
auth_query = SELECT usename, passwd FROM backenly_pooler.lookup(\$1, NULL)

;; Clients: TLS 1.2 or 1.3 is required; a plaintext connection is closed.
client_tls_sslmode = require
client_tls_cert_file = ${CONF_DIR}/client-tls.crt
client_tls_key_file = ${CONF_DIR}/client-tls.key
client_tls_protocols = tlsv1.2,tlsv1.3

;; The database server.
server_tls_sslmode = ${POOLER_SERVER_TLS_MODE}
EOF
  if [ -n "$server_ca" ]; then
    printf 'server_tls_ca_file = %s\n' "$server_ca"
    printf 'server_tls_protocols = tlsv1.2,tlsv1.3\n'
  fi
  cat <<EOF

;; Limits.
max_client_conn = ${POOLER_MAX_CLIENT_CONN}
default_pool_size = ${POOLER_DEFAULT_POOL_SIZE}
min_pool_size = 0
reserve_pool_size = 0
max_db_connections = ${POOLER_MAX_DB_CONNECTIONS}
max_db_client_connections = ${POOLER_MAX_DB_CLIENT_CONNECTIONS}
max_prepared_statements = ${POOLER_MAX_PREPARED_STATEMENTS}

;; Timeouts, in seconds.
query_wait_timeout = 120
query_timeout = ${POOLER_QUERY_TIMEOUT}
idle_transaction_timeout = 300
client_login_timeout = 10
server_idle_timeout = 60

;; Startup parameters: PgBouncer refuses any it does not track. JDBC always
;; sends extra_float_digits, which PostgreSQL 12 and later no longer need.
;; options is not ignored, so a setting passed in it is refused rather than
;; silently dropped.
ignore_startup_parameters = extra_float_digits

;; Keepalives inside a load balancer's idle timeout (350 s on an AWS NLB), so
;; a quiet session is not cut.
tcp_keepalive = 1
tcp_keepidle = 240
tcp_keepintvl = 30
tcp_keepcnt = 4

log_connections = 1
log_disconnections = 1
log_pooler_errors = 1

;; The project databases: last, because the file opens its own [databases]
;; section.
%include ${CONF_DIR}/databases.ini
EOF
}

# ── pg_hba.conf ───────────────────────────────────────────────────────────────
render_hba() {
  cat <<EOF
# Rendered by services/pooler/entrypoint.sh. The first matching line decides.
# Every line is hostssl, so a connection without TLS matches none and is
# refused, as client_tls_sslmode = require also does.
hostssl  pgbouncer        all             all  reject
hostssl  ${AUTH_DB}  all             all  reject
hostssl  replication      all             all  reject
hostssl  all              ${AUTH_USER}  all  reject
hostssl  all              all             all  scram-sha-256
EOF
}

# ── databases.ini ─────────────────────────────────────────────────────────────
# render_databases: the [databases] list for the lines on standard input, one
# per database: its name, optionally followed by `|` and its pool size (the
# smallest connection limit among its logins, backenly_pooler.databases()).
# Every name must be a project database's and every size a whole number from 1
# to 1000, or nothing is rendered. A database with a size gets that pool_size,
# so the pooler never opens more server connections for one of its logins than
# the server lets that login hold; one without uses default_pool_size. The
# auth_query of each names its own database, so a login is checked only for the
# database it belongs to.
render_databases() {
  local line name size
  local -a entries=()
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line%%|*}"
    size=""
    [ "$name" = "$line" ] || size="${line#*|}"
    if ! [[ "$name" =~ $PROJECT_DATABASE ]]; then
      printf 'pooler: "%s" is not a project database name; the list was not changed\n' "${name:0:80}" >&2
      return 1
    fi
    if [ -n "$size" ] && ! { [[ "$size" =~ ^[1-9][0-9]{0,3}$ ]] && ((size <= 1000)); }; then
      printf 'pooler: "%s" is not a pool size for %s; the list was not changed\n' "${size:0:20}" "$name" >&2
      return 1
    fi
    entries+=("$name|$size")
  done
  printf ';; Rendered by services/pooler/entrypoint.sh from backenly_pooler.databases().\n'
  printf '[databases]\n'
  if ((${#entries[@]} > 0)); then
    while IFS='|' read -r name size; do
      printf "%s = host=%s port=%s dbname=%s%s auth_query='SELECT usename, passwd FROM backenly_pooler.lookup(\$1, ''%s'')'\n" \
        "$name" "$POOLER_SERVER_HOST" "$POOLER_SERVER_PORT" "$name" "${size:+ pool_size=$size}" "$name"
    done < <(printf '%s\n' "${entries[@]}" | sort -t '|' -k1,1 -u)
  fi
}

if [ "$ACTION" = check ]; then
  printf '# %s/pgbouncer.ini\n' "$CONF_DIR"
  render_ini
  printf '\n# %s/pg_hba.conf\n' "$CONF_DIR"
  render_hba
  printf '\n# %s/databases.ini is read from backenly_pooler.databases() at start and every %s s\n' \
    "$CONF_DIR" "$POOLER_DATABASE_REFRESH_SECONDS"
  exit 0
fi
if [ "$ACTION" = databases ]; then
  render_databases
  exit $?
fi

render_ini >"$CONF_DIR/pgbouncer.ini"
render_hba >"$CONF_DIR/pg_hba.conf"

# ── The project database list ─────────────────────────────────────────────────
list_conninfo="host=$POOLER_SERVER_HOST port=$POOLER_SERVER_PORT dbname=$AUTH_DB user=$AUTH_USER"
list_conninfo+=" connect_timeout=10 application_name=backenly-pooler-list sslmode=$POOLER_SERVER_TLS_MODE"
if [ -n "$server_ca" ]; then list_conninfo+=" sslrootcert=$server_ca"; fi

# refresh_databases: read the list and write databases.ini. Returns 0 when the
# file changed, 2 when it did not, 1 when the list could not be read, in which
# case the last list stays in place.
refresh_databases() {
  local names
  if ! names="$(PGPASSFILE="$CONF_DIR/pgpass" psql -X -q -At -v ON_ERROR_STOP=1 -d "$list_conninfo" \
    -c "SELECT database || '|' || coalesce(pool_size::text, '') FROM backenly_pooler.databases()" 2>"$CONF_DIR/list.err")"; then
    printf 'pooler: could not read the project database list: %s\n' "$(head -n 1 "$CONF_DIR/list.err")" >&2
    return 1
  fi
  render_databases <<<"$names" >"$CONF_DIR/databases.ini.next" || return 1
  if [ -f "$CONF_DIR/databases.ini" ] && cmp -s "$CONF_DIR/databases.ini.next" "$CONF_DIR/databases.ini"; then
    rm -f "$CONF_DIR/databases.ini.next"
    return 2
  fi
  mv -f "$CONF_DIR/databases.ini.next" "$CONF_DIR/databases.ini"
  printf 'pooler: serving %s project database(s)\n' "$(grep -c '^p_' "$CONF_DIR/databases.ini" || true)"
  return 0
}

# The first list must be read before PgBouncer starts: a pooler that cannot
# read it (a wrong lookup password, an unreachable server) stops here, where
# the deployment sees it, instead of refusing every login forever.
for attempt in $(seq 1 30); do
  rc=0
  refresh_databases || rc=$?
  [ "$rc" -eq 1 ] || break
  if [ "$attempt" -eq 30 ]; then
    printf 'pooler: cannot start: the project database list could not be read for a minute\n' >&2
    exit 1
  fi
  sleep 2
done

# ── Open files ────────────────────────────────────────────────────────────────
# Each client is a socket, and so is each server connection it is paired with.
hard="$(ulimit -Hn)"
if [ "$hard" = unlimited ]; then ulimit -Sn 1048576 2>/dev/null || true; else ulimit -Sn "$hard" 2>/dev/null || true; fi
soft="$(ulimit -Sn)"
need=$((2 * POOLER_MAX_CLIENT_CONN + 64))
if [ "$soft" != unlimited ] && ((soft < need)); then
  refuse "the open-file limit is $soft, and POOLER_MAX_CLIENT_CONN=$POOLER_MAX_CLIENT_CONN needs $need; raise the container's nofile ulimit"
fi

printf 'pooler: %s pooling on port %s for %s:%s (server TLS %s); max_client_conn=%s default_pool_size=%s max_db_connections=%s max_db_client_connections=%s query_timeout=%ss max_prepared_statements=%s database_refresh=%ss\n' \
  "$POOLER_MODE" "$POOLER_LISTEN_PORT" "$POOLER_SERVER_HOST" "$POOLER_SERVER_PORT" "$POOLER_SERVER_TLS_MODE" \
  "$POOLER_MAX_CLIENT_CONN" "$POOLER_DEFAULT_POOL_SIZE" "$POOLER_MAX_DB_CONNECTIONS" \
  "$POOLER_MAX_DB_CLIENT_CONNECTIONS" "$POOLER_QUERY_TIMEOUT" "$POOLER_MAX_PREPARED_STATEMENTS" \
  "$POOLER_DATABASE_REFRESH_SECONDS"

# ── PgBouncer, and the list kept current ──────────────────────────────────────
unset POOLER_TLS_CERT_PEM POOLER_TLS_KEY_PEM POOLER_SERVER_CA_PEM POOLER_AUTH_PASSWORD

/usr/sbin/pgbouncer "$CONF_DIR/pgbouncer.ini" &
pgbouncer_pid=$!

(
  while sleep "$POOLER_DATABASE_REFRESH_SECONDS"; do
    rc=0
    refresh_databases || rc=$?
    # SIGHUP is PgBouncer's reload: new databases appear, and a database no
    # longer listed (its last active login turned off) is closed.
    if [ "$rc" -eq 0 ]; then kill -HUP "$pgbouncer_pid" 2>/dev/null || exit 0; fi
  done
) &
refresher_pid=$!

# This shell stays as the container's first process: it hands the stop signal
# to PgBouncer (SIGINT, the image's STOPSIGNAL, is its safe shutdown) and exits
# with PgBouncer's status.
trap 'kill -INT "$pgbouncer_pid" 2>/dev/null || true' INT
trap 'kill -TERM "$pgbouncer_pid" 2>/dev/null || true' TERM
trap 'kill -QUIT "$pgbouncer_pid" 2>/dev/null || true' QUIT
status=0
while :; do
  if wait "$pgbouncer_pid"; then status=0; else status=$?; fi
  kill -0 "$pgbouncer_pid" 2>/dev/null || break
done
kill "$refresher_pid" 2>/dev/null || true
exit "$status"
