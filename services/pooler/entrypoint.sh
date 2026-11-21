#!/usr/bin/env bash
#
# THE CONNECTION POOLER'S ENTRYPOINT
# ==================================
# Renders PgBouncer's configuration from the environment, then runs PgBouncer
# in the foreground as this container's only process. POOLER_MODE picks the
# pooling mode, and with it the default port: session on 5432, transaction on
# 6543. services/pooler/README.md describes every variable.
#
#   pooler-entrypoint          check the settings, write the configuration
#                              under /run/pooler/<mode>, run PgBouncer
#   pooler-entrypoint check    check the settings, print the pgbouncer.ini and
#                              pg_hba.conf that would run, keep no file
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

refuse() {
  printf 'pooler: refusing to start: %s\n' "$*" >&2
  exit 2
}

ACTION="${1:-run}"
[ "$#" -le 1 ] || refuse "expected no argument, or check"
case "$ACTION" in
  run | check) ;;
  *) refuse "expected no argument, or check" ;;
esac

# ── Every POOLER_ variable is one this file reads ─────────────────────────────
# A misspelt setting would otherwise be ignored and its default used in silence.
readonly KNOWN=" POOLER_MODE POOLER_LISTEN_PORT POOLER_SERVER_HOST POOLER_SERVER_PORT \
POOLER_SERVER_TLS_MODE POOLER_SERVER_CA_PEM POOLER_TLS_CERT_PEM POOLER_TLS_KEY_PEM \
POOLER_AUTH_PASSWORD POOLER_MAX_CLIENT_CONN POOLER_DEFAULT_POOL_SIZE \
POOLER_MAX_DB_CONNECTIONS POOLER_MAX_DB_CLIENT_CONNECTIONS POOLER_QUERY_TIMEOUT \
POOLER_MAX_PREPARED_STATEMENTS "
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

CONF_DIR="$RUN_ROOT/$POOLER_MODE"
if [ "$ACTION" = check ]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
else
  [ -d "$RUN_ROOT" ] && [ -w "$RUN_ROOT" ] ||
    refuse "$RUN_ROOT is not a writable directory (with a read-only root filesystem, mount a writable volume there)"
  rm -rf "$CONF_DIR"
  mkdir -m 0700 "$CONF_DIR"
  WORK="$CONF_DIR"
  # Any temporary file bash makes stays here too, so a read-only root needs
  # no writable /tmp.
  export TMPDIR="$CONF_DIR"
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
unset password

# ── pgbouncer.ini ─────────────────────────────────────────────────────────────
render_ini() {
  cat <<EOF
;; Rendered by services/pooler/entrypoint.sh from the environment at start.
;; services/pooler/README.md explains every value.

[databases]
;; The lookup database is named so it never depends on the fallback below.
${AUTH_DB} = host=${POOLER_SERVER_HOST} port=${POOLER_SERVER_PORT} dbname=${AUTH_DB}
;; Every other database name a client asks for (a project's p_<32 hex>) is
;; that database on the same server; the server decides who may connect to it.
* = host=${POOLER_SERVER_HOST} port=${POOLER_SERVER_PORT}

[pgbouncer]
pool_mode = ${POOLER_MODE}
listen_addr = 0.0.0.0
listen_port = ${POOLER_LISTEN_PORT}
;; TCP only: no unix socket.
unix_socket_dir =

;; Logins: SCRAM-SHA-256 against the verifier backenly_pooler.lookup() returns
;; (tools/managed-db/regional/sql/pooler.sql), passed through to the server.
;; pg_hba.conf turns away the lookup role, the lookup database, replication
;; and the console database before a password is asked for. admin_users and
;; stats_users are deliberately not set, so no login may use the console.
auth_type = hba
auth_hba_file = ${CONF_DIR}/pg_hba.conf
auth_file = ${CONF_DIR}/userlist.txt
auth_user = ${AUTH_USER}
auth_dbname = ${AUTH_DB}
auth_query = SELECT usename, passwd FROM backenly_pooler.lookup(\$1)

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
autodb_idle_timeout = 300

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

if [ "$ACTION" = check ]; then
  printf '# %s/pgbouncer.ini\n' "$CONF_DIR"
  render_ini
  printf '\n# %s/pg_hba.conf\n' "$CONF_DIR"
  render_hba
  exit 0
fi

render_ini >"$CONF_DIR/pgbouncer.ini"
render_hba >"$CONF_DIR/pg_hba.conf"

# ── Open files ────────────────────────────────────────────────────────────────
# Each client is a socket, and so is each server connection it is paired with.
hard="$(ulimit -Hn)"
if [ "$hard" = unlimited ]; then ulimit -Sn 1048576 2>/dev/null || true; else ulimit -Sn "$hard" 2>/dev/null || true; fi
soft="$(ulimit -Sn)"
need=$((2 * POOLER_MAX_CLIENT_CONN + 64))
if [ "$soft" != unlimited ] && ((soft < need)); then
  refuse "the open-file limit is $soft, and POOLER_MAX_CLIENT_CONN=$POOLER_MAX_CLIENT_CONN needs $need; raise the container's nofile ulimit"
fi

printf 'pooler: %s pooling on port %s for %s:%s (server TLS %s); max_client_conn=%s default_pool_size=%s max_db_connections=%s max_db_client_connections=%s query_timeout=%ss max_prepared_statements=%s\n' \
  "$POOLER_MODE" "$POOLER_LISTEN_PORT" "$POOLER_SERVER_HOST" "$POOLER_SERVER_PORT" "$POOLER_SERVER_TLS_MODE" \
  "$POOLER_MAX_CLIENT_CONN" "$POOLER_DEFAULT_POOL_SIZE" "$POOLER_MAX_DB_CONNECTIONS" \
  "$POOLER_MAX_DB_CLIENT_CONNECTIONS" "$POOLER_QUERY_TIMEOUT" "$POOLER_MAX_PREPARED_STATEMENTS"

unset POOLER_TLS_CERT_PEM POOLER_TLS_KEY_PEM POOLER_SERVER_CA_PEM POOLER_AUTH_PASSWORD
exec /usr/sbin/pgbouncer "$CONF_DIR/pgbouncer.ini"
