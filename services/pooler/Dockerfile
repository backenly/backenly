# ============================================================================
# Backenly connection pooler: PgBouncer in front of projects' own databases.
# ============================================================================
#
#   docker build -f services/pooler/Dockerfile -t backenly-pooler .
#
# Built from the repository root, which it needs for docker/certs. One image,
# two processes: a container with POOLER_MODE=session listens on 5432 and one
# with POOLER_MODE=transaction on 6543 (services/pooler/README.md).
#
# Runtime contract:
#   ports        5432 (session pooling), 6543 (transaction pooling), TCP
#   writable     /run/pooler, where the entrypoint writes the configuration
#   user         10001, not root
#   no secrets are baked in: the certificate, its key and the lookup role's
#   password arrive in the environment at start.
# ============================================================================

# Debian 12, pinned by the digest of its multi-architecture index.
FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

# PgBouncer from the PostgreSQL project's apt repository, the same repository
# and signing key the other images install psql from (docker/web.Dockerfile,
# tools/managed-db/regional/Dockerfile.bootstrap). The key is accepted only if
# its fingerprint matches, apt verifies the package against the signed index,
# and the exact build is asserted below. 1.26.1 is the first release with every
# SCRAM fix this pooler's pass-through logins rely on. psql 16 reads the list of
# project databases the pooler serves (services/pooler/entrypoint.sh).
ARG PGBOUNCER_VERSION=1.26.1-1.pgdg12+1
ARG PG_CLIENT_MAJOR=16
ARG PGDG_KEY_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && test "$(gpg --show-keys --with-colons /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc | awk -F: '/^fpr/ {print $10; exit}')" = "$PGDG_KEY_FINGERPRINT" \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "pgbouncer=${PGBOUNCER_VERSION}" "postgresql-client-${PG_CLIENT_MAJOR}" openssl \
 && apt-get purge -y curl gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 # The package's dependencies generate a throwaway "snakeoil" key pair at
 # install. Nothing here uses it, and an image carries no private key.
 && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem
RUN dpkg-query -W -f '${Version}' pgbouncer | grep -qxF "${PGBOUNCER_VERSION}" \
 && pgbouncer --version | head -n 1 | grep -qiE '^pgbouncer 1\.26\.1( |$)' \
 && psql --version | grep -qE "^psql \(PostgreSQL\) ${PG_CLIENT_MAJOR}\." \
 && test -z "$(ls -A /etc/ssl/private)"

# The database server's roots: the RDS roots of every Backenly Cloud region,
# from the pinned, reviewed copies in docker/certs, joined exactly as the web
# and runtime images join them (tests/unit/pooler-image.spec.ts holds this list
# to lib/regions.ts and the result to public/certs/rds-ca-cloud-regions.pem).
# server_tls_sslmode is verify-full against them unless the operator supplies
# another CA (POOLER_SERVER_CA_PEM), as a self-hosted install does.
COPY docker/certs/rds-ca-ap-south-1.pem docker/certs/rds-ca-us-east-1.pem docker/certs/rds-ca-us-west-2.pem docker/certs/rds-ca-eu-central-1.pem docker/certs/rds-ca-ap-southeast-1.pem /etc/ssl/rds/
RUN cat /etc/ssl/rds/rds-ca-ap-south-1.pem /etc/ssl/rds/rds-ca-us-east-1.pem /etc/ssl/rds/rds-ca-us-west-2.pem /etc/ssl/rds/rds-ca-eu-central-1.pem /etc/ssl/rds/rds-ca-ap-southeast-1.pem > /etc/ssl/rds/rds-ca-cloud-regions.pem \
 && chmod 0444 /etc/ssl/rds/*.pem

COPY services/pooler/entrypoint.sh /usr/local/bin/pooler-entrypoint

RUN chmod 0555 /usr/local/bin/pooler-entrypoint \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin pooler \
 && install -d -m 0700 -o 10001 -g 10001 /run/pooler
USER 10001

EXPOSE 5432 6543

# SIGINT is PgBouncer's safe shutdown: no new connections, and it exits once
# every server connection is released (a transaction finishes, or a session
# ends). SIGTERM would wait for every client to disconnect.
STOPSIGNAL SIGINT

ENTRYPOINT ["/usr/local/bin/pooler-entrypoint"]
