#!/usr/bin/env bash
# ============================================================================
# THE CONNECTION POOLER IMAGE, RUN AGAINST POSTGRESQL 16
# ============================================================================
# services/pooler, built and started as it ships: one container per mode, on
# a read-only root filesystem, the image's default ports 5432 (session) and
# 6543 (transaction). Behind it, a PostgreSQL 16 cluster made here that
# accepts TLS connections only (every pg_hba line is hostssl), with logins
# whose passwords are verifiers from lib/data-plane/scram.ts, and
# tools/managed-db/regional/sql/pooler.sql installed by an administrator that
# is not a superuser. Throwaway certificates from a throwaway root, made here.
#
# Shown, on both ports unless said otherwise:
#   - a connection without TLS is refused;
#   - a login in backenly_pooler.logins connects to its own project database
#     with verify-full and runs a query, and the pooler's own connection to
#     the server is TLS;
#   - a wrong password, a login on the server but not in the table, and an
#     inactive login are refused;
#   - postgres, the administrator, backenly_app and backenly_pooler_auth are
#     refused, each with its correct password and a database it may use;
#   - a valid customer login asking for any database but its own project's is
#     refused, though the server itself admits it to most of them: the
#     region's shared database, postgres, template1, backenly_pooler, the
#     pgbouncer console database, and another project's database (which the
#     server refuses too, since CONNECT is granted by name); and the server's
#     own connection log shows the pooler never signed in as that login to
#     any of them;
#   - a project database created after the pooler started is served within
#     the refresh interval, and is no longer served once its last login is
#     turned off;
#   - the two processes really pool differently, and a named prepared
#     statement survives moving to another server connection in transaction
#     mode;
#   - extra_float_digits in options is ignored, search_path in options is
#     applied, and any other setting in options is refused;
#   - nothing the containers log contains a secret;
#   - docker stop ends each pooler cleanly rather than by a kill.
#
#   POOLER_IMAGE_REQUIRE=1 PG_BINDIR=/usr/lib/postgresql/16/bin bash scripts/test/pooler-image.sh
#
# Linux with Docker, PostgreSQL 16 server binaries, openssl, and the
# repository's node_modules (tsx for scram.ts, pg for the mode checks).
# Ports 5432, 6543 and 55432 on the machine must be free.
set -euo pipefail

# A skip is a green tick that proves nothing, so CI sets REQUIRE=1.
REQUIRE="${POOLER_IMAGE_REQUIRE:-0}"
bail() {
  if [ "$REQUIRE" = "1" ]; then echo "FAIL (POOLER_IMAGE_REQUIRE=1): $1"; exit 1; fi
  echo "SKIP: $1"; exit 0
}

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

[ "$(uname -s)" = "Linux" ] || bail "needs Linux with Docker; this is $(uname -s)"
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || bail "needs a running Docker"
command -v openssl >/dev/null 2>&1 || bail "needs openssl"
BIN="${PG_BINDIR:-$(pg_config --bindir 2>/dev/null || true)}"
for tool in initdb pg_ctl psql; do [ -x "$BIN/$tool" ] || bail "needs PostgreSQL 16 server binaries (set PG_BINDIR); no $tool in \"$BIN\""; done
"$BIN/initdb" --version | grep -qE '\(PostgreSQL\) 16\.' || bail "needs PostgreSQL 16; initdb is $("$BIN/initdb" --version)"
[ -x node_modules/.bin/tsx ] && [ -d node_modules/pg ] || bail "needs the repository's node_modules (npm ci)"

DBPORT=55432
SESSION_PORT=5432
TRANSACTION_PORT=6543
for port in "$DBPORT" "$SESSION_PORT" "$TRANSACTION_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then bail "port $port is already in use"; fi
done

WORK="$(mktemp -d)"
TAG="$$"
IMAGE="backenly-pooler:ci-$TAG"
FAILURES=0

ok()   { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }

finish() {
  local status=$?
  if [ "$status" -ne 0 ] || [ "$FAILURES" -ne 0 ]; then
    for mode in session transaction; do
      echo "── pooler-$mode logs ──"
      docker logs "pooler-$mode-$TAG" 2>&1 | tail -80 || true
    done
    echo "── server log ──"
    tail -40 "$WORK/server.log" 2>/dev/null || true
  fi
  docker rm -f "pooler-session-$TAG" "pooler-transaction-$TAG" >/dev/null 2>&1 || true
  docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
  [ -d "$WORK/data" ] && "$BIN/pg_ctl" -D "$WORK/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap finish EXIT

secret() { openssl rand -hex 24; }
SUPER_PW="$(secret)"
ADMIN_PW="$(secret)"
APP_PW="$(secret)"
AUTH_PW="$(secret)"
LOGIN_PW="$(secret)"
ABSENT_PW="$(secret)"
INACTIVE_PW="$(secret)"
OTHER_PW="$(secret)"
NEW_PW="$(secret)"
PROJECT_DB="p_$(openssl rand -hex 16)"
OTHER_DB="p_$(openssl rand -hex 16)"
NEW_DB="p_$(openssl rand -hex 16)"
# Stands in for a region's own shared database, which any login may CONNECT to.
SHARED_DB=backenly_regional
REFRESH_SECONDS=2

# ── Certificates ────────────────────────────────────────────────────────────
echo "certificates"
(
  cd "$WORK"
  # Configuration files of their own, so nothing depends on the machine's openssl.cnf.
  cat > root.cnf <<'CNF'
[req]
prompt = no
distinguished_name = dn
[dn]
CN = pooler ci root
[root]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
CNF
  cat > leaf.cnf <<'CNF'
[req]
prompt = no
distinguished_name = dn
[dn]
CN = localhost
CNF
  cat > leaf.ext <<'CNF'
subjectAltName = DNS:localhost,IP:127.0.0.1
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config root.cnf -extensions root -keyout ca.key -out ca.pem 2>/dev/null
  for name in server pooler; do
    openssl req -new -newkey rsa:2048 -nodes -config leaf.cnf -keyout "$name.key" -out "$name.csr" 2>/dev/null
    openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile leaf.ext -out "$name.pem" 2>/dev/null
    openssl verify -CAfile ca.pem "$name.pem" >/dev/null
  done
  chmod 0600 server.key pooler.key ca.key
)

# ── The server: PostgreSQL 16, TLS only ─────────────────────────────────────
echo "server"
printf '%s' "$SUPER_PW" > "$WORK/superuser-password"
"$BIN/initdb" -D "$WORK/data" -U postgres --pwfile="$WORK/superuser-password" --auth=scram-sha-256 \
  -E UTF8 --locale=C --no-sync >/dev/null
cat >> "$WORK/data/postgresql.conf" <<EOF
port = $DBPORT
listen_addresses = 'localhost'
unix_socket_directories = ''
ssl = on
ssl_cert_file = '$WORK/server.pem'
ssl_key_file = '$WORK/server.key'
ssl_min_protocol_version = 'TLSv1.2'
fsync = off
log_connections = on
EOF
cat > "$WORK/data/pg_hba.conf" <<EOF
hostssl all all 127.0.0.1/32 scram-sha-256
hostssl all all ::1/128 scram-sha-256
EOF
"$BIN/pg_ctl" -D "$WORK/data" -l "$WORK/server.log" -w -t 60 start >/dev/null

# db USER PASSWORD DATABASE [psql args...]: straight to the server.
db() {
  local user="$1" password="$2" database="$3"; shift 3
  "$BIN/psql" -X -q -tA -v ON_ERROR_STOP=1 \
    -d "host=localhost port=$DBPORT dbname=$database user=$user password=$password sslmode=verify-full sslrootcert=$WORK/ca.pem" "$@"
}

# Verifiers from lib/data-plane/scram.ts, one per line, in this order.
mapfile -t V < <(
  PW_APP="$APP_PW" PW_AUTH="$AUTH_PW" PW_LOGIN="$LOGIN_PW" PW_ABSENT="$ABSENT_PW" PW_INACTIVE="$INACTIVE_PW" \
  PW_OTHER="$OTHER_PW" PW_NEW="$NEW_PW" \
    node_modules/.bin/tsx -e "
      const { scramSha256Verifier } = require('./lib/data-plane/scram');
      for (const k of ['APP', 'AUTH', 'LOGIN', 'ABSENT', 'INACTIVE', 'OTHER', 'NEW']) console.log(scramSha256Verifier(process.env['PW_' + k]));
    "
)
[ "${#V[@]}" -eq 7 ] || { echo "scram.ts did not produce seven verifiers"; exit 1; }

# An administrator like the RDS master, which is not a superuser.
db postgres "$SUPER_PW" postgres -c "CREATE ROLE pooler_admin LOGIN CREATEROLE CREATEDB PASSWORD '$ADMIN_PW'"
db pooler_admin "$ADMIN_PW" postgres <<SQL
CREATE ROLE backenly_app LOGIN PASSWORD '${V[0]}';
CREATE ROLE backenly_pooler_auth LOGIN NOINHERIT PASSWORD '${V[1]}';
CREATE ROLE bkn_ci_login LOGIN PASSWORD '${V[2]}';
CREATE ROLE bkn_ci_absent LOGIN PASSWORD '${V[3]}';
CREATE ROLE bkn_ci_inactive LOGIN PASSWORD '${V[4]}';
CREATE ROLE bkn_ci_other LOGIN PASSWORD '${V[5]}';
CREATE ROLE bkn_ci_new LOGIN PASSWORD '${V[6]}';
CREATE DATABASE backenly_pooler;
-- Created with PostgreSQL's default grants, as a region's shared database
-- still is: CONNECT for PUBLIC.
CREATE DATABASE $SHARED_DB;
CREATE DATABASE $PROJECT_DB;
CREATE DATABASE $OTHER_DB;
SQL
db pooler_admin "$ADMIN_PW" "$PROJECT_DB" <<SQL
REVOKE ALL ON DATABASE $PROJECT_DB FROM PUBLIC;
REVOKE ALL ON DATABASE $OTHER_DB FROM PUBLIC;
-- backenly_app may connect too, so the pooler refusing it is the pooler's doing.
GRANT CONNECT ON DATABASE $PROJECT_DB TO bkn_ci_login, bkn_ci_absent, bkn_ci_inactive, backenly_app;
GRANT CREATE ON DATABASE $PROJECT_DB TO bkn_ci_login;
GRANT CONNECT ON DATABASE $OTHER_DB TO bkn_ci_other;
SQL
db bkn_ci_login "$LOGIN_PW" "$PROJECT_DB" -c "CREATE SCHEMA ci_schema"
db pooler_admin "$ADMIN_PW" backenly_pooler -f tools/managed-db/regional/sql/pooler.sql
db backenly_app "$APP_PW" backenly_pooler <<SQL
INSERT INTO backenly_pooler.logins (rolname, verifier, database, active) VALUES
  ('bkn_ci_login', '${V[2]}', '$PROJECT_DB', true),
  ('bkn_ci_inactive', '${V[4]}', '$PROJECT_DB', false),
  ('bkn_ci_other', '${V[5]}', '$OTHER_DB', true);
SQL

# The control: straight to the server, each of these logs in. Whatever the
# pooler refuses below, it refuses on its own account.
for pair in "bkn_ci_absent:$ABSENT_PW:$PROJECT_DB" "bkn_ci_inactive:$INACTIVE_PW:$PROJECT_DB" \
            "backenly_app:$APP_PW:$PROJECT_DB" "backenly_pooler_auth:$AUTH_PW:backenly_pooler" \
            "pooler_admin:$ADMIN_PW:postgres" "postgres:$SUPER_PW:$PROJECT_DB" \
            "bkn_ci_login:$LOGIN_PW:$SHARED_DB" "bkn_ci_login:$LOGIN_PW:postgres" "bkn_ci_login:$LOGIN_PW:template1"; do
  IFS=: read -r user password database <<< "$pair"
  [ "$(db "$user" "$password" "$database" -c 'SELECT current_user')" = "$user" ] ||
    { echo "control failed: $user cannot log in to $database on the server itself"; exit 1; }
done
# And the server's own answer to another project's database.
if db bkn_ci_login "$LOGIN_PW" "$OTHER_DB" -c 'SELECT 1' >/dev/null 2>&1; then
  echo "control failed: the server admits bkn_ci_login to another project's database"; exit 1
fi

# server_logins DATABASE: how often the server has let bkn_ci_login past its
# password into DATABASE (logged before the CONNECT check, so a login the
# server then refuses is counted too).
server_logins() { grep -c "connection authorized: user=bkn_ci_login database=$1 " "$WORK/server.log" || true; }
OFF_LIMITS=("$SHARED_DB" postgres template1 backenly_pooler "$OTHER_DB")
declare -A BEFORE=()
for database in "${OFF_LIMITS[@]}"; do BEFORE[$database]="$(server_logins "$database")"; done
[ "${BEFORE[$SHARED_DB]}" -ge 1 ] && [ "${BEFORE[$OTHER_DB]}" -ge 1 ] ||
  { echo "control failed: the server log does not record logins (log_connections)"; exit 1; }

# ── The image ───────────────────────────────────────────────────────────────
echo "image"
docker build -q -f services/pooler/Dockerfile -t "$IMAGE" . >/dev/null
# The tmpfs below is mounted with the image user's owner, which hides what a
# Fargate task volume does: it starts owned by root, and only an image that
# declares /run/pooler a VOLUME gets the directory's owner carried onto it.
[ "$(docker inspect -f '{{json .Config.Volumes}}' "$IMAGE")" = '{"/run/pooler":{}}' ] ||
  { echo "the image does not declare /run/pooler a VOLUME: a Fargate task volume there stays root's and the pooler cannot start"; exit 1; }
echo "  declares VOLUME /run/pooler"
echo "  $(docker run --rm --entrypoint pgbouncer "$IMAGE" --version | head -n 1)"

export POOLER_SERVER_CA_PEM POOLER_TLS_CERT_PEM POOLER_TLS_KEY_PEM POOLER_AUTH_PASSWORD
POOLER_SERVER_CA_PEM="$(cat "$WORK/ca.pem")"
POOLER_TLS_CERT_PEM="$(cat "$WORK/pooler.pem")"
POOLER_TLS_KEY_PEM="$(cat "$WORK/pooler.key")"
POOLER_AUTH_PASSWORD="$AUTH_PW"
for mode in session transaction; do
  docker run -d --name "pooler-$mode-$TAG" --network host --read-only \
    --tmpfs /run/pooler:rw,uid=10001,gid=10001,mode=0700 --ulimit nofile=65536:65536 \
    -e POOLER_MODE="$mode" -e POOLER_SERVER_HOST=localhost -e POOLER_SERVER_PORT="$DBPORT" \
    -e POOLER_DATABASE_REFRESH_SECONDS="$REFRESH_SECONDS" \
    -e POOLER_SERVER_CA_PEM -e POOLER_TLS_CERT_PEM -e POOLER_TLS_KEY_PEM -e POOLER_AUTH_PASSWORD \
    "$IMAGE" >/dev/null
done
unset POOLER_SERVER_CA_PEM POOLER_TLS_CERT_PEM POOLER_TLS_KEY_PEM POOLER_AUTH_PASSWORD

for port in "$SESSION_PORT" "$TRANSACTION_PORT"; do
  for _ in $(seq 1 90); do
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && break
    for mode in session transaction; do
      [ "$(docker inspect -f '{{.State.Running}}' "pooler-$mode-$TAG")" = true ] ||
        { echo "pooler-$mode exited"; exit 1; }
    done
    sleep 1
  done
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null || { echo "nothing listens on $port"; exit 1; }
done

# via PORT USER PASSWORD DATABASE SSLMODE SQL [EXTRA conninfo]: through the pooler.
via() {
  "$BIN/psql" -X -tA -v ON_ERROR_STOP=1 \
    -d "host=localhost port=$1 dbname=$4 user=$2 password=$3 sslmode=$5 sslrootcert=$WORK/ca.pem connect_timeout=10 ${7:-}" \
    -c "$6" 2>&1
}

# refused DESCRIPTION PATTERN via-args...: the connection or query fails, saying PATTERN.
refused() {
  local description="$1" pattern="$2" out; shift 2
  if out="$(via "$@")"; then
    fail "$description: it connected ($out)"
  elif grep -qiE "$pattern" <<< "$out"; then
    ok "$description"
  else
    fail "$description: refused, but not as expected: $out"
  fi
}

# ── What the pooler admits, and what it does not ────────────────────────────
for port in "$SESSION_PORT" "$TRANSACTION_PORT"; do
  echo "port $port"
  refused "a connection without TLS is refused" "SSL required" \
    "$port" bkn_ci_login "$LOGIN_PW" "$PROJECT_DB" disable 'SELECT 1'

  out="$(via "$port" bkn_ci_login "$LOGIN_PW" "$PROJECT_DB" verify-full \
    "SELECT current_user || '|' || current_database() || '|' || CASE WHEN ssl THEN 'tls' ELSE 'plain' END FROM pg_stat_ssl WHERE pid = pg_backend_pid()")" || true
  if [ "$out" = "bkn_ci_login|$PROJECT_DB|tls" ]; then
    ok "a login in the table connects to its own database with verify-full and runs a query, over TLS to the server too"
  else
    fail "a login in the table could not run a query in its own database: $out"
  fi

  refused "a wrong password is refused" "authentication failed" \
    "$port" bkn_ci_login "$(secret)" "$PROJECT_DB" verify-full 'SELECT 1'
  refused "a login on the server but not in the table is refused" "no such user|authentication failed" \
    "$port" bkn_ci_absent "$ABSENT_PW" "$PROJECT_DB" verify-full 'SELECT 1'
  refused "an inactive login is refused" "no such user|authentication failed" \
    "$port" bkn_ci_inactive "$INACTIVE_PW" "$PROJECT_DB" verify-full 'SELECT 1'
  refused "postgres is refused" "no such user|authentication failed" \
    "$port" postgres "$SUPER_PW" "$PROJECT_DB" verify-full 'SELECT 1'
  refused "the administrator is refused" "no such database|no such user|authentication failed" \
    "$port" pooler_admin "$ADMIN_PW" postgres verify-full 'SELECT 1'
  refused "backenly_app is refused" "no such user|authentication failed" \
    "$port" backenly_app "$APP_PW" "$PROJECT_DB" verify-full 'SELECT 1'
  refused "backenly_pooler_auth is refused, even with its password" "rejected|no authentication method|not allowed" \
    "$port" backenly_pooler_auth "$AUTH_PW" "$PROJECT_DB" verify-full 'SELECT 1'

  # A valid customer login, asking for a database that is not its own. An
  # unlisted name fails as a wrong password would (PgBouncer's mock login).
  for database in "$SHARED_DB" postgres template1; do
    refused "a customer login asking for $database is refused" "authentication failed|no such database" \
      "$port" bkn_ci_login "$LOGIN_PW" "$database" verify-full 'SELECT 1'
  done
  refused "a customer login asking for backenly_pooler is refused" "rejected|no such user|no authentication method" \
    "$port" bkn_ci_login "$LOGIN_PW" backenly_pooler verify-full 'SELECT 1'
  refused "a customer login asking for the pgbouncer console database is refused" "rejected|not allowed|no authentication method|no such user" \
    "$port" bkn_ci_login "$LOGIN_PW" pgbouncer verify-full 'SHOW POOLS'
  refused "the pgbouncer console database is refused to the lookup role" "rejected|not allowed|no authentication method" \
    "$port" backenly_pooler_auth "$AUTH_PW" pgbouncer verify-full 'SHOW POOLS'
  refused "a customer login asking for another project's database is refused" "no such user|authentication failed|permission denied" \
    "$port" bkn_ci_login "$LOGIN_PW" "$OTHER_DB" verify-full 'SELECT 1'
  out="$(via "$port" bkn_ci_other "$OTHER_PW" "$OTHER_DB" verify-full 'SELECT current_database()')" || true
  [ "$out" = "$OTHER_DB" ] && ok "that other project's own login reaches it" || fail "the other project's login could not reach its database: $out"
done

echo "the server's view"
for database in "${OFF_LIMITS[@]}"; do
  after="$(server_logins "$database")"
  [ "$after" = "${BEFORE[$database]}" ] && ok "the pooler never signed in as the customer login to $database" ||
    fail "the server logged $((after - BEFORE[$database])) login(s) as bkn_ci_login to $database through the pooler"
done

# ── A project database created while the pooler runs ───────────────────────
echo "a new project database (list refreshed every ${REFRESH_SECONDS}s)"
db pooler_admin "$ADMIN_PW" postgres -c "CREATE DATABASE $NEW_DB"
db pooler_admin "$ADMIN_PW" "$NEW_DB" <<SQL
REVOKE ALL ON DATABASE $NEW_DB FROM PUBLIC;
GRANT CONNECT ON DATABASE $NEW_DB TO bkn_ci_new;
SQL
db backenly_app "$APP_PW" backenly_pooler -c \
  "INSERT INTO backenly_pooler.logins (rolname, verifier, database) VALUES ('bkn_ci_new', '${V[6]}', '$NEW_DB')"

# until_through PORT EXPECTED-PATTERN DESCRIPTION: poll the new login through the pooler.
until_through() {
  local port="$1" pattern="$2" description="$3" out=""
  for _ in $(seq 1 $((REFRESH_SECONDS * 10 + 10))); do
    out="$(via "$port" bkn_ci_new "$NEW_PW" "$NEW_DB" verify-full 'SELECT current_database()')" || true
    if grep -qE "$pattern" <<< "$out"; then ok "$description"; return 0; fi
    sleep 1
  done
  fail "$description: last answer $out"
}
for port in "$SESSION_PORT" "$TRANSACTION_PORT"; do
  until_through "$port" "^$NEW_DB\$" "port $port serves the new project database"
done
db backenly_app "$APP_PW" backenly_pooler -c \
  "UPDATE backenly_pooler.logins SET active = false, updated_at = now() WHERE rolname = 'bkn_ci_new'"
# The lookup answers "no such user" at once; the expected answer is the one
# for a database that is no longer on the list (the mock login fails as a
# wrong password would), which shows the list itself changed.
for port in "$SESSION_PORT" "$TRANSACTION_PORT"; do
  until_through "$port" "authentication failed|no such database" \
    "port $port drops the database from its list once its last login is turned off"
done

# ── Startup parameters ──────────────────────────────────────────────────────
echo "startup parameters (port $TRANSACTION_PORT)"
out="$(via "$TRANSACTION_PORT" bkn_ci_login "$LOGIN_PW" "$PROJECT_DB" verify-full 'SELECT 1' "options='-c extra_float_digits=3'")" || true
[ "$out" = 1 ] && ok "extra_float_digits, as JDBC sends it, is accepted and ignored" || fail "extra_float_digits was not accepted: $out"
out="$(via "$TRANSACTION_PORT" bkn_ci_login "$LOGIN_PW" "$PROJECT_DB" verify-full 'SHOW search_path' "options='-c search_path=ci_schema'")" || true
[ "$out" = ci_schema ] && ok "search_path in options is applied" || fail "search_path in options was not applied: $out"
refused "any other setting in options is refused, not dropped" "unsupported" \
  "$TRANSACTION_PORT" bkn_ci_login "$LOGIN_PW" "$PROJECT_DB" verify-full 'SELECT 1' "options='-c statement_timeout=5s'"

# Not asserted: whether PgBouncer offers SCRAM channel binding to clients.
if via "$TRANSACTION_PORT" bkn_ci_login "$LOGIN_PW" "$PROJECT_DB" verify-full 'SELECT 1' 'channel_binding=require' >/dev/null; then
  echo "  info  channel_binding=require connects"
else
  echo "  info  channel_binding=require does not connect: clients must leave channel_binding at prefer"
fi

# ── The two modes, and prepared statements ──────────────────────────────────
echo "pooling modes"
cat > "$WORK/modes.cjs" <<'JS'
const fs = require('fs')
const { Client } = require('pg')
const config = () => ({
  host: 'localhost',
  port: Number(process.env.P_PORT),
  database: process.env.P_DB,
  user: process.env.P_USER,
  password: process.env.P_PASSWORD,
  ssl: { ca: fs.readFileSync(process.env.P_CA, 'utf8') },
})
const pid = async (client) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
;(async () => {
  const a = new Client(config())
  const b = new Client(config())
  await a.connect()
  await b.connect()
  // Two idle clients: in session mode each holds its own server connection;
  // in transaction mode the second reuses the one the first just released.
  const first = await pid(a)
  const second = await pid(b)
  // A named prepared statement, then the same name again from a different
  // server connection: b holds the first one inside a transaction meanwhile.
  const prepared = { name: 'ci_statement', text: 'SELECT $1::int + 1 AS n' }
  const one = (await a.query({ ...prepared, values: [1] })).rows[0].n
  await b.query('BEGIN')
  await b.query('SELECT 1')
  const two = (await a.query({ ...prepared, values: [2] })).rows[0].n
  const movedFrom = await pid(b)
  const movedTo = await pid(a)
  await b.query('COMMIT')
  await a.end()
  await b.end()
  console.log(JSON.stringify({ samePid: first === second, prepared: one === 2 && two === 3, moved: movedFrom !== movedTo }))
})().catch((err) => {
  console.log(JSON.stringify({ error: err.message }))
  process.exit(1)
})
JS
modes() {
  P_PORT="$1" P_DB="$PROJECT_DB" P_USER=bkn_ci_login P_PASSWORD="$LOGIN_PW" P_CA="$WORK/ca.pem" \
    NODE_PATH="$REPO/node_modules" node "$WORK/modes.cjs" 2>&1 || true
}
out="$(modes "$SESSION_PORT")"
[ "$out" = '{"samePid":false,"prepared":true,"moved":true}' ] &&
  ok "session pooling: each client keeps its own server connection" || fail "session pooling: $out"
out="$(modes "$TRANSACTION_PORT")"
[ "$out" = '{"samePid":true,"prepared":true,"moved":true}' ] &&
  ok "transaction pooling: server connections are shared between transactions, and prepared statements follow" ||
  fail "transaction pooling: $out"

# ── Logs ────────────────────────────────────────────────────────────────────
echo "logs"
for mode in session transaction; do
  logs="$(docker logs "pooler-$mode-$TAG" 2>&1)"
  grep -q "pooler: $mode pooling on port" <<< "$logs" && ok "$mode: the start line names the mode" || fail "$mode: no start line"
  grep -q "pooler: serving 2 project database(s)" <<< "$logs" && ok "$mode: the start listed the two project databases" ||
    fail "$mode: the project database list was not logged at start"
  found=0
  for value in "$AUTH_PW" "$LOGIN_PW" "$(sed -n 2p "$WORK/pooler.key")" "$(sed -n 2p "$WORK/pooler.pem")"; do
    if grep -qF -- "$value" <<< "$logs"; then found=1; fi
  done
  [ "$found" = 0 ] && ok "$mode: no secret in the logs" || fail "$mode: a secret value appears in the logs"
done

# ── Stopping ────────────────────────────────────────────────────────────────
echo "stopping"
for mode in session transaction; do
  docker stop -t 30 "pooler-$mode-$TAG" >/dev/null
  code="$(docker inspect -f '{{.State.ExitCode}}' "pooler-$mode-$TAG")"
  [ "$code" != 137 ] && ok "$mode: docker stop ends it cleanly (exit $code)" || fail "$mode: it had to be killed"
done

echo
if [ "$FAILURES" -ne 0 ]; then echo "$FAILURES check(s) failed"; exit 1; fi
echo "the pooler image behaves as documented"
