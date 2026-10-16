#!/usr/bin/env bash
# Build and push the regional database bootstrap image.
#
#   BOOTSTRAP_AWS_ACCOUNT_ID=<account> BOOTSTRAP_AWS_REGION=<region> \
#     bash tools/managed-db/regional/build-and-push.sh
#
# Run from the repository root, on a machine with Docker and an authenticated
# AWS CLI (in this project: the WSL builder).
#
# The region is required rather than defaulted: ECR is regional, and the task
# that runs this image runs in the region whose database it initialises. The
# repository defaults to backenly-runtime for the reason
# tools/managed-db/runner/build-and-push.sh gives: the execution role's pull
# scope names the existing repositories, and the image contents and the task
# definition are the separation that matters, not the repository name.
#
# The build context is ASSEMBLED from image-files.txt, so the image holds those
# files and nothing else from the checkout.
set -euo pipefail

REGION="${BOOTSTRAP_AWS_REGION:-}"
ACCOUNT="${BOOTSTRAP_AWS_ACCOUNT_ID:-}"
REPO="${BOOTSTRAP_ECR_REPO:-backenly-runtime}"
[ -n "$REGION" ] || { echo "BOOTSTRAP_AWS_REGION is not set (the region whose database this image initialises)"; exit 2; }
[ -n "$ACCOUNT" ] || { echo "BOOTSTRAP_AWS_ACCOUNT_ID is not set"; exit 2; }

ROOT="$(pwd)"
HERE="tools/managed-db/regional"
[ -f "$ROOT/$HERE/image-files.txt" ] || { echo "run from the repository root"; exit 2; }

FILES=()
while IFS= read -r f; do
  [ -f "$ROOT/$f" ] || { echo "image-files.txt lists $f, which does not exist"; exit 2; }
  FILES+=("$f")
done < <(grep -vE '^[[:space:]]*(#|$)' "$ROOT/$HERE/image-files.txt")

if [ -n "$(git status --porcelain -- "${FILES[@]}" "$HERE/image-files.txt" "$HERE/Dockerfile.bootstrap")" ]; then
  echo "refusing: the image inputs have uncommitted changes; commit them so the tag identifies the image"
  exit 2
fi

SHA="$(git rev-parse --short HEAD)"
TAG="regional-bootstrap-${SHA}"
IMAGE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

CTX="$(mktemp -d /tmp/regional-bootstrap-ctx.XXXXXX)"
trap 'rm -rf "$CTX"' EXIT

for f in "${FILES[@]}"; do
  mkdir -p "$CTX/tree/$(dirname "$f")"
  cp "$ROOT/$f" "$CTX/tree/$f"
done
cp "$ROOT/$HERE/Dockerfile.bootstrap" "$CTX/"

echo "context:"
find "$CTX" -type f -printf '  %P\n' | sort

docker build -f "$CTX/Dockerfile.bootstrap" -t "$IMAGE" "$CTX"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

docker push "$IMAGE"

DIGEST="$(aws ecr describe-images --repository-name "$REPO" --image-ids imageTag="$TAG" \
  --region "$REGION" --output text --query 'imageDetails[0].imageDigest')"

echo
echo "pushed ${REPO}:${TAG}"
echo "digest ${DIGEST}"
echo "image  ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}@${DIGEST}"
