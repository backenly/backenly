# Connection pooler

Customers connect psql, an ORM or any other PostgreSQL client to their
project's own database through this pooler. It is
[PgBouncer](https://www.pgbouncer.org/) 1.26.1, run by Backenly, with one
image and two listeners:

| Port | Pooling | Use it for |
|------|---------|-----------|
| 5432 | session | psql, migrations (Prisma Migrate, Drizzle Kit, Alembic, Flyway), `LISTEN`, advisory locks, session `SET`, anything that holds state between transactions |
| 6543 | transaction | application traffic, serverless functions, many short connections |

Each port is its own PgBouncer process in its own container, started from the
same image with a different `POOLER_MODE`. On Backenly Cloud both run in one
task behind a network load balancer that passes TCP straight through, so
PgBouncer itself terminates TLS.

A client names the project's database (`p_<32 hex>`) and the project's login
(`bkn_...`). The pooler checks the password with SCRAM-SHA-256 and signs in to
the database server as that login, using the keys from the client's own proof.
Only project databases are served, and each login only for its own project's
database. Logins that are not a project's (Backenly's own roles, the server
administrator, PostgREST's roles) are never served.

## Which databases are served

PgBouncer's `pg_hba.conf` matches database names exactly (it has no pattern
form), and its `auth_query` is given the user name only, so neither can limit
a login to databases named `p_<32 hex>`. The pooler therefore has no `*`
fallback entry at all. It lists project databases explicitly, in
`/run/pooler/<mode>/databases.ini`, which `pgbouncer.ini` includes:

- The list is `backenly_pooler.databases()`: every existing project database
  with at least one active login. The entrypoint reads it before PgBouncer
  starts (and does not start PgBouncer until it has), and again every
  `POOLER_DATABASE_REFRESH_SECONDS`. When it changes, PgBouncer reloads: a new
  project's database is served within that interval, and a database whose last
  login was turned off is closed, its clients disconnected.
- A login to any database not on the list (the region's shared database,
  `postgres`, `template1`, or any other name) fails inside PgBouncer,
  which runs no lookup and opens no server connection for it. It answers as it
  would a wrong password, so which databases exist is not revealed.
- Each listed database carries its own `auth_query`, with its name written in:
  `backenly_pooler.lookup($1, 'p_...')` returns a verifier only for a login of
  that database. A login asking for another project's database is refused by
  the pooler before the server is asked; the server would refuse it too, since
  `CONNECT` on a project database is granted to its own logins by name.

If the list cannot be read later (the server restarting, say), the last list
stays in force and the failure is logged on each attempt.

## How a login is checked

1. Backenly computes the login's SCRAM-SHA-256 verifier
   (`lib/data-plane/scram.ts`), sets it on the server with
   `ALTER ROLE <login> PASSWORD '<verifier>'`, and writes the same string to
   `backenly_pooler.logins` in the `backenly_pooler` database on that server
   (`tools/managed-db/regional/sql/pooler.sql`), with the database it belongs
   to.
2. A client connects over TLS and names a database. A name not on the list
   fails there (above). `pg_hba.conf` in the container turns away the
   `pgbouncer` console database, the `backenly_pooler` database, replication
   connections and the lookup role.
3. PgBouncer runs that database's `auth_query` as `backenly_pooler_auth`,
   which may do nothing on the server but call `backenly_pooler.lookup` and
   `backenly_pooler.databases`. The lookup returns the verifier only for an
   active login of that database whose role can log in now, and no row for
   anything else, so the login fails.
4. The client's proof is checked against that verifier, and PgBouncer opens
   the server connection with the keys the proof carried. This works because
   the server holds the identical verifier.

Turning a login off: setting `active = false` stops new logins through the
pooler immediately. A client already signed in keeps its keys, and in
transaction mode PgBouncer reuses them to open new server connections, so the
role must also change on the server (`ALTER ROLE ... NOLOGIN`, or a new
verifier written to both places) and its sessions be ended
(`pg_terminate_backend`).

## Environment

Every setting is an environment variable. A missing required one, an empty
one, a malformed one, or any `POOLER_` variable not listed here stops the
container with exit status 2 and one line naming the setting. Values of the
secret settings are never printed.

### Required

| Variable | Meaning |
|----------|---------|
| `POOLER_MODE` | `session` or `transaction`. |
| `POOLER_SERVER_HOST` | The PostgreSQL server: a host name or IPv4 address. With `verify-full` it must be the name on the server's certificate. |
| `POOLER_TLS_CERT_PEM` | Secret. The certificate clients see, as PEM, optionally followed by its intermediates. It must be valid for the host name customers connect to, and unexpired. |
| `POOLER_TLS_KEY_PEM` | Secret. The unencrypted PEM private key of that certificate. |
| `POOLER_AUTH_PASSWORD` | Secret. The password of `backenly_pooler_auth` on the server: 16 to 1024 printable ASCII characters, without spaces, double quotes or backslashes. |

PEM values may hold real newlines, or the two characters `\n` where a secret
store keeps the value on one line. On Backenly Cloud the three secrets are
injected from AWS Secrets Manager by the task definition.

### Optional

| Variable | Default | Meaning |
|----------|---------|---------|
| `POOLER_LISTEN_PORT` | 5432 (session), 6543 (transaction) | TCP port to listen on. |
| `POOLER_SERVER_PORT` | 5432 | The server's port. |
| `POOLER_SERVER_TLS_MODE` | `verify-full` | `verify-full`, `verify-ca` or `disable`. `disable` is for a server on the same private host or network that does not offer TLS. |
| `POOLER_SERVER_CA_PEM` | the RDS roots in the image | PEM of the CA certificate(s) that signed the server's certificate. Not allowed with `disable`. |
| `POOLER_MAX_CLIENT_CONN` | 5000 | Client connections this process accepts in total. |
| `POOLER_DEFAULT_POOL_SIZE` | 5 | Server connections per login and database pair. |
| `POOLER_MAX_DB_CONNECTIONS` | 10 | Server connections per database, across all its logins. Must be at least the pool size. |
| `POOLER_MAX_DB_CLIENT_CONNECTIONS` | 0 (no limit) | Client connections per database. When set, at least `POOLER_MAX_DB_CONNECTIONS` and at most `POOLER_MAX_CLIENT_CONN`. |
| `POOLER_QUERY_TIMEOUT` | 900 | Seconds a query may run before the pooler cancels it; 0 turns it off. |
| `POOLER_MAX_PREPARED_STATEMENTS` | 200 | Protocol-level prepared statements tracked per server connection in transaction mode; 0 turns the support off. |
| `POOLER_DATABASE_REFRESH_SECONDS` | 10 | How often the list of project databases is read again (1 to 3600). A new project's database is served at most this long after its first login is written. |

The image trusts the RDS root certificates of every Backenly Cloud region
(`docker/certs`, the same pinned copies the web and runtime images use), so on
Backenly Cloud no CA setting is needed.

## Limits and what they mean

All limits are per PgBouncer process. A task runs two processes, and a service
may run several tasks, so a database can receive up to
`POOLER_MAX_DB_CONNECTIONS x 2 x tasks` server connections. Size the server's
`max_connections` (and any per-role `CONNECTION LIMIT`) for that.

| Setting | Value | Effect |
|---------|-------|--------|
| `max_client_conn` | `POOLER_MAX_CLIENT_CONN` | Connections beyond it are refused. The entrypoint raises the open-file limit to its hard limit and refuses to start if it is below `2 x max_client_conn + 64`. |
| `default_pool_size` | `POOLER_DEFAULT_POOL_SIZE` | In session mode, the number of sessions a login can have open on one database at once; more wait. In transaction mode, the number of transactions running at once. |
| `max_db_connections` | `POOLER_MAX_DB_CONNECTIONS` | Caps server connections to one database whatever the number of logins. |
| `max_db_client_connections` | `POOLER_MAX_DB_CLIENT_CONNECTIONS` | Optional cap on clients of one database, so one project cannot take every client slot. |
| `query_wait_timeout` | 120 s | A client waiting this long for a server connection gets an error. PgBouncer sends a notice after 5 s of waiting. |
| `query_timeout` | `POOLER_QUERY_TIMEOUT` | A query running longer is cancelled and its server connection closed. Long migrations need a value above their longest statement. |
| `idle_transaction_timeout` | 300 s | A client idle inside an open transaction this long is disconnected, so a forgotten `BEGIN` cannot hold a server connection. |
| `client_login_timeout` | 10 s | A client that has not finished logging in by then is disconnected. |
| `server_idle_timeout` | 60 s | Idle server connections are closed after a minute, so quiet projects hold none. |
| `max_prepared_statements` | `POOLER_MAX_PREPARED_STATEMENTS` | Lets clients use named prepared statements in transaction mode. |
| `tcp_keepidle` / `tcp_keepintvl` / `tcp_keepcnt` | 240 / 30 / 4 | Keepalives inside the network load balancer's 350 s idle timeout, so a quiet session is not cut. |

### A login's connections are shared by the two ports

A project's logins have a connection limit on the server (PostgreSQL's
`CONNECTION LIMIT`, set from the project's plan). `backenly_pooler.databases()`
gives the smallest limit among a database's logins, and each pooler sizes that
database's pool to its share of it:

| Limit | Session pool (5432) | Transaction pool (6543) |
|-------|---------------------|-------------------------|
| 2 | 1 | 1 |
| 5 | 2 | 3 |
| 20 | 10 | 10 |

Half goes to sessions and the rest to transactions. The two pools together are
never larger than the limit, so what one port is doing cannot lock the same
login out of the other. Before this, each pool was the size of the whole limit:
two sessions closed on port 5432 left two idle server connections there for
`server_idle_timeout`, and port 6543 refused the same login for a minute.

A limit of 1 cannot be shared, so each pool takes it, and that login can still
meet the refusal. A database whose logins have no limit uses
`POOLER_DEFAULT_POOL_SIZE` on both ports.

In session mode a pool of 1 means one session at a time for that login: a
second waits for the first to end, up to `query_wait_timeout`.

Fixed, not configurable: TLS 1.2 or 1.3 required from clients; no unix
socket; no admin or stats users, so the `pgbouncer` console database cannot be
used; `ignore_startup_parameters = extra_float_digits` (below).

`pooler-entrypoint check` prints the exact `pgbouncer.ini` and `pg_hba.conf`
the current environment would run, and exits; `pooler-entrypoint databases`
prints the `[databases]` list it would write for the names on standard input:

```bash
docker run --rm --env-file pooler.env backenly-pooler check
```

The entrypoint stays the container's first process: it starts PgBouncer,
keeps the database list current beside it, hands the stop signal to PgBouncer
and exits with PgBouncer's status. The image needs `psql` for the list, and
the lookup role reads it over the same TLS settings PgBouncer uses.

## Client compatibility

PgBouncer refuses a startup parameter it does not track. It tracks
`application_name`, `client_encoding`, `DateStyle`, `IntervalStyle`,
`TimeZone`, `standard_conforming_strings`, `default_transaction_read_only`,
`session_authorization` and `scram_iterations`, and, set in the startup
packet or in `options`, `search_path`. The one parameter common clients send
beyond those is `extra_float_digits`, which JDBC always sends and which
PostgreSQL 12 and later do not need, so it is accepted and ignored. Anything
else in `options` (for example `-c statement_timeout=5s`) is refused with an
error rather than silently dropped; set it with `SET` after connecting in
session mode, or once for the login with
`ALTER ROLE CURRENT_USER SET statement_timeout = '5s'`.

| Client | Notes |
|--------|-------|
| psql, libpq, psycopg 2/3 | `sslmode=require` or stricter, on both ports. PgBouncer 1.25 and later also accept libpq 17's `sslnegotiation=direct`. Leave `channel_binding` at its default, `prefer`: whether PgBouncer offers channel binding to clients is not established here, and the CI job prints what `require` does. |
| node-postgres (`pg`), Drizzle on `pg` | `ssl: true` or `sslmode=require` in the URL. Named prepared statements work in transaction mode. |
| postgres.js, Drizzle on postgres.js | `ssl: 'require'`. Prepared statements work in transaction mode. |
| Prisma ORM | Application: port 6543, without `pgbouncer=true` (PgBouncer 1.21+ with prepared statements needs none). Prisma Migrate: port 5432. |
| JDBC (pgjdbc), Hibernate, Flyway | `sslmode=require`. `extra_float_digits` is accepted and ignored. |
| asyncpg, SQLAlchemy | `ssl='require'`. Prepared statements work in transaction mode. |

In transaction mode, session state does not carry from one transaction to the
next: `SET` without `LOCAL`, `LISTEN`, session advisory locks, temporary tables
kept across transactions, and `WITH HOLD` cursors belong on port 5432.

## Running it yourself

A self-hosted install runs the same image against its own PostgreSQL 16:

1. On the server, as an administrator that owns databases (a superuser works,
   and so does a role with `CREATEDB CREATEROLE`):
   create `backenly_app` and `backenly_pooler_auth` (both `LOGIN`), set the
   latter's password, create the database `backenly_pooler`, and run
   `tools/managed-db/regional/sql/pooler.sql` in it with `psql -f`, which also
   reads `sql/verify-pooler.sql` beside it. The header of that file lists the
   steps exactly. On Backenly Cloud the regional procedure does all of this
   (`tools/managed-db/regional/bootstrap.sh`, the step `pooler`), and keeps
   the lookup role's password in the secret its launch config names
   (`secrets.poolerAuth`).
2. For each login customers should reach through the pooler, set its verifier
   on the server, grant it `CONNECT` on its own database only, and insert the
   same verifier and that database into `backenly_pooler.logins` (as
   `backenly_app`). Databases must be named `p_<32 hex>`.
3. Run one container per mode:

```bash
docker build -f services/pooler/Dockerfile -t backenly-pooler .

docker run -d --name pooler-session -p 5432:5432 \
  -e POOLER_MODE=session \
  -e POOLER_SERVER_HOST=db.internal -e POOLER_SERVER_CA_PEM \
  -e POOLER_TLS_CERT_PEM -e POOLER_TLS_KEY_PEM -e POOLER_AUTH_PASSWORD \
  backenly-pooler

docker run -d --name pooler-transaction -p 6543:6543 \
  -e POOLER_MODE=transaction \
  -e POOLER_SERVER_HOST=db.internal -e POOLER_SERVER_CA_PEM \
  -e POOLER_TLS_CERT_PEM -e POOLER_TLS_KEY_PEM -e POOLER_AUTH_PASSWORD \
  backenly-pooler
```

`-e NAME` with no value passes the variable from your shell, which keeps
multi-line PEM values intact and off the command line. A server on the same
private network without TLS takes `POOLER_SERVER_TLS_MODE=disable` instead of
a CA.

The container runs as uid 10001 and writes its configuration under
`/run/pooler`; with a read-only root filesystem, mount a writable volume
there. Logs go to standard output. Stopping the container sends `SIGINT`,
PgBouncer's safe shutdown: it takes no new connections and exits once every
server connection is released, or when the runtime's stop timeout ends.

## Tests

- `tests/unit/data-plane-scram.spec.ts`: verifiers against PostgreSQL 16's
  stored values, its regression suite and RFC 7677.
- `tests/unit/pooler-image.spec.ts`: the Dockerfile's pins and trusted roots,
  and the entrypoint's rendering and refusals (`check`).
- `tests/integration/pooler-auth.spec.ts`: a login with a computed verifier on
  a real PostgreSQL 16, and every grant `pooler.sql` makes.
- `tests/integration/regional-bootstrap.spec.ts`: the regional procedure
  making `backenly_pooler_auth` and `backenly_pooler` as an administrator that
  is not a superuser, verifying them, refusing to replace the role's password
  unasked, and rotating it when asked.
- `scripts/test/pooler-image.sh` (the `connection pooler image` CI job): the
  image itself against a PostgreSQL 16 that requires TLS, on both ports.
