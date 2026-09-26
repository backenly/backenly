# ============================================================================
# Backenly Web — Next.js standalone, the only service behind the load balancer.
# ============================================================================
#
#   docker build --platform linux/amd64 -f docker/web.Dockerfile -t backenly-web .
#
# EDITION: build the Cloud image from a COMPOSED checkout. Run
# scripts/apply-overlay.sh against the private overlay FIRST — this Dockerfile
# cannot fetch it, and a build from a public checkout produces a single-tenant
# image. next.config.js names overlay-allowlist.json and lib/cloud/** in
# outputFileTracingIncludes because the loader reads them at runtime and the
# tracer cannot see through the manifest to find them.
#
# Runtime contract:
#   port          3000 (PORT)
#   health        GET /api/health
#   persistent    WORKSPACE_DIR=/app/workspace and BACKUP_DIR=/app/backups,
#                 both EFS on AWS. Everything else is ephemeral.
#   object store  native S3 through the ECS task role: no STORAGE_S3_ENDPOINT,
#                 no static keys, and STORAGE_S3_PUBLIC_URL / STORAGE_CDN_URL
#                 MUST stay unset or the app will hand out direct URLs to a
#                 Block-Public-Access bucket (lib/services/s3Storage.ts).
#   resources     0.5 vCPU / 1 GB
#   no secrets are baked in — every value arrives at run time
#
# NOT read-only root: Next writes into .next/cache at runtime. The writable
# surface is that plus the two EFS mounts and /tmp.
# ============================================================================

# ── Build ───────────────────────────────────────────────────────────────────
FROM node:20-slim AS build

# Before npm ci: Prisma sniffs the OpenSSL version to pick its query engine,
# and a bare node:20-slim has none, so it would fetch the 1.1.x engine while
# the runtime stage is 3.0.x.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

COPY . .

# Build-time public values. These are compiled into the browser bundle, so they
# are public by definition — but they are still build ARGs rather than baked
# defaults, so a different deployment can set its own.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ARG NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=""
ARG NEXT_PUBLIC_PADDLE_ENVIRONMENT=production
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=""
ARG NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY=true
ARG NEXT_PUBLIC_ENABLE_NEW_DASHBOARD_READINESS=true
ARG BACKENLY_EDITION=cloud

ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=$NEXT_PUBLIC_PADDLE_CLIENT_TOKEN \
    NEXT_PUBLIC_PADDLE_ENVIRONMENT=$NEXT_PUBLIC_PADDLE_ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY=$NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY \
    NEXT_PUBLIC_ENABLE_NEW_DASHBOARD_READINESS=$NEXT_PUBLIC_ENABLE_NEW_DASHBOARD_READINESS \
    BACKENLY_EDITION=$BACKENLY_EDITION

# Placeholders so `next build` can evaluate modules while collecting page data.
# None may be real: the image is scanned for them, and nothing here reaches the
# artifact. SENTRY_AUTH_TOKEN is deliberately unset — with it the build uploads
# sourcemaps and hangs against sharp.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:1/unused \
    DIRECT_URL=postgresql://build:build@127.0.0.1:1/unused \
    JWT_SECRET=build-time-placeholder-not-a-production-secret \
    OPENAI_API_KEY=build-not-a-real-openai-key

# The ARG defaults above are LOCALHOST. A build that forgets --build-arg takes
# them silently and produces an image whose every OAuth redirect and
# password-reset link points at http://localhost:3000, with the signup CAPTCHA
# and error reporting off — and it still boots, serves and passes its health
# check, so nothing downstream catches it. That happened once; this is why it
# cannot happen twice. Run BEFORE the build, so the failure costs seconds.
RUN npx tsx scripts/verify-public-build-inputs.ts --inputs

RUN npm run build

# And again against what was actually emitted, because the check above proves
# only what the build was TOLD. This proves the value reached the artifact.
RUN npx tsx scripts/verify-public-build-inputs.ts --artifact

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The standalone tree already contains its traced node_modules, the Prisma
# engine, and — for a Cloud build — lib/cloud and overlay-allowlist.json.
# postbuild has already copied .next/static and public/ into it.
COPY --from=build /src/.next/standalone ./

# esbuild, and the platform binary it drives. Deploying a route-module function
# validates it by compiling its TypeScript here (validateRouteModule in
# lib/services/ai-functions/route-module-runner.ts), through a require that
# output tracing cannot see: esbuild is a native binary and is loaded that way
# on purpose, so the standalone tree never contained it. Every deploy_code on
# the AWS images failed with "Cannot find module 'esbuild'" (measured on
# staging 2026-09-26; the production v7 image lacked it as well).
COPY --from=build /src/node_modules/esbuild ./node_modules/esbuild
COPY --from=build /src/node_modules/@esbuild ./node_modules/@esbuild

# Asserted, not assumed: the build fails unless this image can compile
# TypeScript the way the function runner does.
RUN node -e "const e=require('esbuild');const o=e.transformSync('export const n: number = 1',{loader:'ts',format:'cjs'});if(!o.code.includes('exports'))process.exit(1);console.log('esbuild '+e.version+' compiles TypeScript in this image')"

# ── Containment at the boundary that can actually assert it ─────────────────
#
# next.config.js bounds ROUTE traces, and that works. It cannot bound
# server/instrumentation.js.nft.json, which is not a route: reading the build's
# own manifests, every file below is referenced by that one trace and by no
# route trace. instrumentation.ts imports most of the repository, so its trace
# carries 2,435 entries.
#
# These four directories cannot be a production runtime dependency, and it was
# checked rather than assumed: nothing under lib/, app/, server/ or
# instrumentation.ts imports, requires or exec()s anything in scripts/ — every
# mention is a comment or documentation string, and the deploy scripts run on
# the host from a git checkout, never from here.
#
# Deliberately untouched: node_modules/, lib/, app/, public/, .next/,
# prisma/ and node_modules/.prisma — real runtime assets live in all of them.
#
# Asserted, not hoped for: the build fails if anything survives.
RUN rm -rf ./tests ./docs ./scripts ./__tests__ \
 && rm -f ./docker-compose*.yml \
 && rm -rf ./docker \
 && REMAIN="$( { find . -path ./node_modules -prune -o \
        \( -path './tests/*' -o -path './docs/*' -o -path './scripts/*' \
           -o -path './__tests__/*' -o -name 'docker-compose*.yml' \) -print; } | wc -l )" \
 && echo "excluded-tree files remaining: $REMAIN" \
 && test "$REMAIN" -eq 0

# The EFS mount points. Created here so the image is correct even when nothing
# is mounted, and owned by the runtime user so the app can write to them.
RUN mkdir -p /app/workspace /app/backups && chown -R node:node /app/workspace /app/backups

# HOSTNAME=0.0.0.0 is REQUIRED, not cosmetic. Next's standalone server binds to
# process.env.HOSTNAME, and Docker sets that to the container's own hostname —
# so the server comes up, logs "Ready", listens on a name nothing else can
# reach, and every request times out. It looks like a hung app rather than a
# binding mistake.
# Trust the Amazon RDS root CAs for every Node TLS connection.
#
# node-postgres treats `sslmode=require` as full verification (pg 8.13+), and
# the RDS certificate chain is not in Node's default roots. So every `pg.Pool`
# in the app - the workspace pool behind every autonomy catalog probe among
# them - failed with "self-signed certificate in certificate chain" against
# RDS, while Prisma, which ships its own trust store, connected fine. Measured
# on AWS staging 2026-09-22: fourteen invariants reported as errors, so the
# reconciler saw no gaps and healed nothing, and every health check was green.
#
# NODE_EXTRA_CA_CERTS ADDS these roots; public CAs stay trusted and chain
# verification stays on. The bundle is the pinned ap-south-1 set already used
# by tools/migration-lineage (a test asserts the two copies are identical).
# Inert against any server not signed by RDS, so it is safe in every image; an
# operator on another RDS region overrides the variable with that bundle.
COPY docker/certs/rds-ca-ap-south-1.pem /app/certs/rds-ca-ap-south-1.pem

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    WORKSPACE_DIR=/app/workspace \
    BACKUP_DIR=/app/backups \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-ca-ap-south-1.pem

EXPOSE 3000

USER node

# server.js calls process.chdir(__dirname) on startup, which is why .env has to
# live beside it on the Hetzner host. In a container there is no .env at all:
# configuration arrives as real environment variables.
#
# HOSTNAME is set HERE, at exec, as well as in ENV above, because the ENV value
# does not survive every platform. ECS Fargate replaces it with the task's own
# hostname: measured on AWS staging 2026-09-25, Next logged
# "Local: http://ip-10-20-10-179.ap-south-1.compute.internal:3000", so nothing
# listened on loopback. The ALB still worked (it targets that address), which
# is why it looked healthy, while everything in the task that calls
# 127.0.0.1:3000 failed. The contract sweep reported "ingress_unreachable" every
# minute and never verified a single project. `exec` keeps node as PID 1 so
# SIGTERM still reaches it.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node server.js"]
