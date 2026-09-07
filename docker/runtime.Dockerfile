# ============================================================================
# Backenly Runtime — the Express server that answers every /api/v1/* request.
# ============================================================================
#
# Build from the REPOSITORY ROOT so the build context contains server/, lib/
# and, for a Cloud image, the composed lib/cloud overlay:
#
#   docker build --platform linux/amd64 -f docker/runtime.Dockerfile -t backenly-runtime .
#
# This image is deliberately NOT the repository. It carries a pre-bundled
# server plus the one dependency that cannot be bundled — the Prisma client,
# which is generated code paired with a platform-specific query engine.
#
# EDITION: server/index.ts imports lib/edition/cloud-extension, so a Cloud
# image must be built from a COMPOSED checkout (scripts/apply-overlay.sh). A
# public checkout produces a single-tenant image, which is correct, not a bug.
#
# Runtime contract:
#   port            3001 (RUNTIME_PORT)
#   health          GET /health
#   filesystem      read-only root; nothing is written outside /tmp
#   no EFS, no volumes, no persistent state
#   resources       0.25 vCPU / 512 MB (measured idle RSS ~57 MiB)
#   required env    DATABASE_URL, JWT_SECRET, CORS_ORIGIN
#   optional env    RUNTIME_PORT, POSTGREST_URL, DIRECT_URL, BACKENLY_EDITION
#   no secrets are baked in — every value above arrives at run time
# ============================================================================

# ── Build ───────────────────────────────────────────────────────────────────
FROM node:20-slim AS build

# openssl BEFORE npm ci. Prisma sniffs the OpenSSL version when it resolves
# which query engine to fetch, and a bare node:20-slim has none — so it falls
# back to `debian-openssl-1.1.x` while the runtime stage (which does install
# openssl) is 3.0.x. The engine then does not match the image it ships in and
# PrismaClient fails to start. Installing it here makes both stages agree.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Dependencies first so the layer caches across source edits. `npm ci` needs
# both manifests; postinstall runs `prisma generate`, which needs the schema.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# Only what the bundler actually reads. Copying the whole repository would drag
# app/, .next/ and the test tree into the build for no benefit.
COPY tsconfig.json tsconfig.server.json ./
COPY scripts/build-runtime-bundle.mjs ./scripts/
COPY server ./server
COPY lib ./lib

RUN node scripts/build-runtime-bundle.mjs

# Generate explicitly rather than relying on the postinstall hook, so the
# client is produced with openssl present and lands in node_modules/.prisma.
RUN npx prisma generate

# Prisma ships an engine per platform it was generated for. Keep only the one
# this image runs on; each of the others is ~16 MB of dead weight.
#
# Then ASSERT one survived. A silent mismatch here is invisible until the
# container boots and PrismaClient cannot load its engine, which is a slow way
# to discover a build problem.
RUN find node_modules/.prisma -name 'libquery_engine-*' \
      ! -name '*debian-openssl-3.0.x*' -delete \
 && find node_modules/.prisma -name 'query_engine-windows*' -delete \
 && ENGINES="$(find node_modules/.prisma -name 'libquery_engine-*' | wc -l)" \
 && echo "prisma engines kept: $ENGINES" \
 && find node_modules/.prisma -name 'libquery_engine-*' \
 && test "$ENGINES" -ge 1

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Prisma's query engine links against OpenSSL.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /src/dist-runtime ./dist-runtime
COPY --from=build /src/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /src/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /src/prisma/schema.prisma ./prisma/schema.prisma

ENV NODE_ENV=production \
    RUNTIME_PORT=3001

EXPOSE 3001

USER node

# node directly, not npm or tsx: one process, so SIGTERM reaches the server and
# the graceful-shutdown handler in server/index.ts runs instead of being
# swallowed by a wrapper.
CMD ["node", "dist-runtime/index.mjs"]
