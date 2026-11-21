# ============================================================================
# Backenly PostgREST host: one PostgREST process per project database.
# ============================================================================
#
# Build from the REPOSITORY ROOT (the build reads the lockfile for esbuild):
#
#   docker build --platform linux/amd64 -f services/pgrst-host/Dockerfile -t backenly-pgrst-host .
#
# A project can have a database of its own; PostgREST serves one database per
# process, so this service runs one PostgREST child per project database and
# proxies to it (services/pgrst-host/main.ts). The children are the official
# PostgREST binary, unmodified, copied from the same release the compose files
# run (docker-compose.dev.yml, docker/compose.stack.yml), pinned here by digest.
# tests/unit/pgrst-host-image.spec.ts holds the tags equal, and CI runs the
# host's integration suite against this exact image.
#
# Runtime contract:
#   port          3200 (PGRST_HOST_PORT), the only port; children bind 127.0.0.1
#   health        GET /ready
#   filesystem    nothing is written; a read-only root is fine
#   user          node (uid 1000), never root
#   required env  PGRST_HOST_JWT_SECRET, PGRST_HOST_DB_URI
#   no secrets are baked in: every value arrives at run time
#
# POSTGREST_IMAGE may name a mirror of the same image, by digest.
# ============================================================================

ARG POSTGREST_IMAGE=postgrest/postgrest:v14.15@sha256:2f8e7b656f09db697a8875177694b417b35cb76c21370de07fc54e711e902326

FROM ${POSTGREST_IMAGE} AS postgrest

# ── Build ───────────────────────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /src

# Only esbuild, at the version the repository's lockfile pins. The lockfile is
# kept outside the install directory so npm does not read it as a project.
COPY package-lock.json /tmp/repository-lock.json
RUN version="$(node -p "require('/tmp/repository-lock.json').packages['node_modules/esbuild'].version")" \
 && npm install --no-save --no-package-lock --no-audit --no-fund "esbuild@${version}" \
 && node -e "const v=require('esbuild').version;if(v!=='${version}')process.exit(1);console.log('esbuild '+v)"

COPY services/pgrst-host ./services/pgrst-host

# The bundle may contain services/pgrst-host and Node's built-ins only; the
# build fails if it would reach anything else (no platform client, no package).
RUN node services/pgrst-host/build.mjs --out /src/dist-pgrst-host \
 && test -s /src/dist-pgrst-host/pgrst-host.cjs

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# A static binary: it needs nothing from this image.
COPY --from=postgrest /bin/postgrest /usr/local/bin/postgrest
RUN postgrest --version

WORKDIR /opt/pgrst-host
COPY --from=build /src/dist-pgrst-host/pgrst-host.cjs ./pgrst-host.cjs

# The Amazon RDS root certificates of every Backenly Cloud region, as the web
# and runtime images carry them, for an authenticator URI that verifies the
# server (sslmode=verify-full&sslrootcert=/opt/pgrst-host/certs/rds-ca-cloud-regions.pem).
# Inert otherwise.
COPY docker/certs/rds-ca-ap-south-1.pem docker/certs/rds-ca-us-east-1.pem docker/certs/rds-ca-us-west-2.pem docker/certs/rds-ca-eu-central-1.pem docker/certs/rds-ca-ap-southeast-1.pem /opt/pgrst-host/certs/
RUN cd /opt/pgrst-host/certs \
 && cat rds-ca-ap-south-1.pem rds-ca-us-east-1.pem rds-ca-us-west-2.pem rds-ca-eu-central-1.pem rds-ca-ap-southeast-1.pem > rds-ca-cloud-regions.pem \
 && chown -R root:root /opt/pgrst-host \
 && chmod -R u=rwX,go=rX /opt/pgrst-host

ENV NODE_ENV=production \
    PGRST_HOST_PORT=3200 \
    PGRST_HOST_BINARY=/usr/local/bin/postgrest

EXPOSE 3200

USER node

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PGRST_HOST_PORT||3200)+'/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "/opt/pgrst-host/pgrst-host.cjs"]
