#!/usr/bin/env bash
# Build and push the Layer 3 migration runner.
#
#   MIGRATE_AWS_ACCOUNT_ID=<account> bash tools/managed-db/runner/build-and-push.sh
#
# Run from the repository root, on a machine with Docker and an authenticated
# AWS CLI (in this project: the WSL builder).
#
# The build context is ASSEMBLED rather than the repository root. That keeps the
# build fast, and more importantly it makes it impossible for the gitignored
# prisma/migrations working directory (which still holds the legacy corpus on
# developer machines) to enter the image. Only the canonical chain ships.
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
# backenly-runtime, not a repository of its own: the staging execution role's
# EcrPull is scoped to backenly-{web,runtime,postgrest,pgrst-probe}, and a new
# repository would mean an IAM change to publish a migration image. Measured:
# pulling from backenly-db-bootstrap returned 403 at task start. The separation
# that matters is the image contents and the task definition, not the repository
# name, so this ships as an immutable migrate-<sha> tag alongside the app image.
REPO="${MIGRATE_ECR_REPO:-backenly-runtime}"
ACCOUNT="${MIGRATE_AWS_ACCOUNT_ID:-}"
[ -n "$ACCOUNT" ] || { echo "MIGRATE_AWS_ACCOUNT_ID is not set"; exit 2; }

ROOT="$(pwd)"
[ -f "$ROOT/prisma/schema.prisma" ] || { echo "run from the repository root"; exit 2; }
[ -d "$ROOT/prisma/migrations-canonical" ] || { echo "no canonical migrations; generate the baseline first"; exit 2; }

SHA="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- prisma/migrations-canonical tools/managed-db/runner)" ]; then
  echo "refusing: the runner inputs have uncommitted changes; commit them so the tag identifies the image"
  exit 2
fi

TAG="migrate-${SHA}"
IMAGE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

CTX="$(mktemp -d /tmp/migrate-ctx.XXXXXX)"
trap 'rm -rf "$CTX"' EXIT

cp "$ROOT/tools/managed-db/runner/package.json" "$CTX/"
cp "$ROOT/tools/managed-db/runner/package-lock.json" "$CTX/"
cp "$ROOT/tools/managed-db/runner/entrypoint.sh" "$CTX/"
cp "$ROOT/tools/managed-db/runner/Dockerfile.migrate" "$CTX/"
cp -r "$ROOT/tools/managed-db/runner/checks" "$CTX/checks"
cp "$ROOT/prisma/schema.prisma" "$CTX/schema.prisma"
cp -r "$ROOT/prisma/migrations-canonical" "$CTX/migrations-canonical"

echo "context:"
find "$CTX" -maxdepth 2 -printf '  %P\n' | sort | sed '/^  $/d'

docker build -f "$CTX/Dockerfile.migrate" -t "$IMAGE" "$CTX"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

docker push "$IMAGE"

DIGEST="$(aws ecr describe-images --repository-name "$REPO" --image-ids imageTag="$TAG" \
  --region "$REGION" --output text --query 'imageDetails[0].imageDigest')"

echo
echo "pushed ${REPO}:${TAG}"
echo "digest ${DIGEST}"
echo "image  ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}@${DIGEST}"
