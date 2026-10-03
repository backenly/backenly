#!/usr/bin/env bash
# Build and push the maintenance runner.
#
#   MAINTENANCE_AWS_ACCOUNT_ID=<account> BASE_IMAGE=<production runtime image> \
#     bash tools/maintenance-runner/build-and-push.sh
#
# Run from the repository root. The bundle is built here rather than in the
# image so the build context is one file: nothing else from this repository
# can end up in an image that runs against production.
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
REPO="${MAINTENANCE_ECR_REPO:-backenly-runtime}"
ACCOUNT="${MAINTENANCE_AWS_ACCOUNT_ID:-}"
BASE="${BASE_IMAGE:-}"
[ -n "$ACCOUNT" ] || { echo "MAINTENANCE_AWS_ACCOUNT_ID is not set"; exit 2; }
[ -n "$BASE" ] || { echo "BASE_IMAGE is not set; pass the production runtime image, pinned by digest"; exit 2; }

ROOT="$(pwd)"
[ -f "$ROOT/scripts/run-maintenance-plan.ts" ] || { echo "run from the repository root"; exit 2; }

SHA="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- scripts/run-maintenance-plan.ts scripts/maintenance-acceptance-fixture.ts lib/autonomy/maintenance tools/maintenance-runner)" ]; then
  echo "refusing: the runner inputs have uncommitted changes; commit them so the tag identifies the image"
  exit 2
fi

TAG="maintenance-${SHA}"
IMAGE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

CTX="$(mktemp -d /tmp/maintenance-ctx.XXXXXX)"
trap 'rm -rf "$CTX"' EXIT

# `@prisma/client` and `.prisma` come from the base image. Everything else,
# including `pg`, is bundled: the runtime image does not ship `pg` as a package
# because its own server bundle already contains it.
#
# MAINTENANCE_BUNDLE lets the bundle be built elsewhere and handed in. On this
# project's Windows + WSL setup it has to be: node_modules holds the win32
# esbuild binary, so a bundle step inside WSL dies with "you installed esbuild
# for another platform". Bundle on the host, build the image here.
if [ -n "${MAINTENANCE_BUNDLE:-}" ]; then
  [ -f "$MAINTENANCE_BUNDLE" ] || { echo "MAINTENANCE_BUNDLE does not exist: $MAINTENANCE_BUNDLE"; exit 2; }
  [ -n "${FIXTURE_BUNDLE:-}" ] || { echo "FIXTURE_BUNDLE is not set"; exit 2; }
  [ -f "$FIXTURE_BUNDLE" ] || { echo "FIXTURE_BUNDLE does not exist: $FIXTURE_BUNDLE"; exit 2; }
  echo "using prebuilt bundles"
  cp "$MAINTENANCE_BUNDLE" "$CTX/maintenance.cjs"
  cp "$FIXTURE_BUNDLE" "$CTX/fixture.cjs"
else
  echo "bundling…"
  node -e '
    require("esbuild").build({
      entryPoints: ["scripts/run-maintenance-plan.ts"],
      bundle: true, platform: "node", target: "node20", format: "cjs",
      outfile: process.argv[1], minify: true,
      external: ["@prisma/client", ".prisma/client", "pg-native", "pg-cloudflare", "cloudflare:sockets"],
      alias: { "server-only": "./tools/maintenance-runner/server-only-stub.js" },
      logLevel: "warning",
    }).catch(e => { console.error(e); process.exit(1) })
  ' "$CTX/maintenance.cjs"
  node -e '
    require("esbuild").build({
      entryPoints: ["scripts/maintenance-acceptance-fixture.ts"],
      bundle: true, platform: "node", target: "node20", format: "cjs",
      outfile: process.argv[1], minify: true,
      external: ["@prisma/client", ".prisma/client", "pg-native", "pg-cloudflare", "cloudflare:sockets"],
      alias: { "server-only": "./tools/maintenance-runner/server-only-stub.js" },
      logLevel: "warning",
    }).catch(e => { console.error(e); process.exit(1) })
  ' "$CTX/fixture.cjs"
fi

# Whatever produced it, it must be a real bundle and not a stub or a stale file.
grep -q 'run-maintenance-plan\|--plan-version' "$CTX/maintenance.cjs" \
  || { echo "refusing: maintenance.cjs does not look like the maintenance entry point"; exit 2; }
grep -q 'maintenance-prod-acceptance' "$CTX/fixture.cjs" \
  || { echo "refusing: fixture.cjs does not look like the acceptance fixture"; exit 2; }

# The fixture must never grow an arbitrary-SQL surface.
#
# Checked on the SOURCE, not the bundle. The fixture now builds through the
# product's own lifecycle, so its bundle contains the product — including
# unrelated code that happens to mention "--schema" (the Prisma CLI's own flag,
# among others). Grepping the bundle was a proxy for a property that belongs to
# this file's argument parser, and the proxy stopped being true the moment the
# bundle grew. tests/unit/maintenance-acceptance-fixture.spec.ts enumerates the
# exact arg() set and is the precise form of this check.
FIXTURE_SRC="$ROOT/scripts/maintenance-acceptance-fixture.ts"
for forbidden in "'--sql'" "'--query'" "'--table'" "'--schema'" "'--column'" "'--force'"; do
  if grep -qF -- "arg($forbidden)" "$FIXTURE_SRC"; then
    echo "refusing: the fixture reads $forbidden"
    exit 2
  fi
done

cp "$ROOT/tools/maintenance-runner/Dockerfile.maintenance" "$CTX/"
cp "$ROOT/tools/maintenance-runner/rds-ca.pem" "$CTX/"
cp "$ROOT/prisma/schema.prisma" "$CTX/schema.prisma"
grep -q 'BEGIN CERTIFICATE' "$CTX/rds-ca.pem" || { echo "refusing: rds-ca.pem is not a certificate bundle"; exit 2; }
echo "context:"
find "$CTX" -maxdepth 1 -printf '  %P\n' | sort | sed '/^  $/d'

docker build --platform linux/amd64 --build-arg "BASE_IMAGE=$BASE" \
  -f "$CTX/Dockerfile.maintenance" -t "$IMAGE" "$CTX"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
docker push "$IMAGE"

DIGEST="$(aws ecr describe-images --repository-name "$REPO" --image-ids imageTag="$TAG" \
  --region "$REGION" --output text --query 'imageDetails[0].imageDigest')"

echo
echo "pushed ${REPO}:${TAG}"
echo "digest ${DIGEST}"
echo "image  ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}@${DIGEST}"
