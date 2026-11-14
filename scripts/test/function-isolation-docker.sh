#!/usr/bin/env bash
# ============================================================================
# FUNCTION ISOLATION, PROVEN AGAINST A BUILT IMAGE
# ============================================================================
# Function code must never run in a process that holds a platform secret.
# The images start as root, start the function
# supervisor, and run the app as `node`; the supervisor runs each function as
# a uid of its own (lib/services/ai-functions/isolation/).
#
# This starts the image with planted values where the platform's secrets go,
# then, from inside the container and as the app user, runs real functions
# through the real supervisor and checks every property the fix claims:
# distinct pool uids, an environment with nothing secret, no other process's
# environment, /app and its volumes and the supervisor socket out of reach,
# timeouts and memory limits enforced, nothing a run started or wrote left
# behind (scripts/test/function-isolation-probe.cjs).
#
#   bash scripts/test/function-isolation-docker.sh            builds docker/runtime.Dockerfile
#   bash scripts/test/function-isolation-docker.sh <image>    an image already built (web or runtime)
#
# Needs Docker. The container's command is replaced with `sleep infinity`, so
# the app itself never starts and no database is needed; the entrypoint, the
# supervisor and the runner are the image's own.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/../.."

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  IMAGE=backenly-runtime:function-isolation-test
  docker build --platform linux/amd64 -f docker/runtime.Dockerfile -t "$IMAGE" .
fi

NAME="backenly-fn-isolation-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Planted values: a run must never see any of them. The database URL is
# assembled so no scanner reads a fixture as a credential.
DB_URL="postgresql://planted:planted-not-a-real-password"
DB_URL="${DB_URL}@127.0.0.1:1/planted"

docker run -d --name "$NAME" \
  -e JWT_SECRET=planted-not-a-real-jwt-secret-docker \
  -e MASTER_ENCRYPTION_KEY=planted-not-a-real-master-key-docker \
  -e ENV_VAR_ENCRYPTION_KEY=planted-not-a-real-env-key-docker \
  -e STRIPE_SECRET_KEY=planted-not-a-real-stripe-key-docker \
  -e INTERNAL_API_TOKEN=planted-not-a-real-internal-token-docker \
  -e DATABASE_URL="$DB_URL" \
  -e CORS_ORIGIN=http://localhost \
  "$IMAGE" sleep infinity >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$NAME" test -S /tmp/backenly-fn/supervisor.sock 2>/dev/null; then break; fi
  sleep 1
done

echo "── supervisor log"
docker logs "$NAME" 2>&1 | sed 's/^/   /'
if docker logs "$NAME" 2>&1 | grep -q REFUSING; then
  echo "FAIL  the supervisor refused to run functions in this image (its reason is above)"
  exit 1
fi

echo "── the app runs as node, under tini"
APP_UID="$(docker exec "$NAME" sh -c 'for p in /proc/[0-9]*; do if grep -qa "^sleep" "$p/cmdline" 2>/dev/null; then awk "/^Uid:/ {print \$2}" "$p/status"; fi; done' | head -n1)"
PID1="$(docker exec "$NAME" sh -c 'tr "\0" " " < /proc/1/cmdline')"
echo "   app uid: ${APP_UID:-?}   pid 1: ${PID1}"
[ "$APP_UID" = "1000" ] || { echo "FAIL  the app is not running as node (uid 1000)"; exit 1; }
case "$PID1" in *tini*) ;; *) echo "FAIL  PID 1 is not tini"; exit 1 ;; esac

echo "── probe, as the app user"
docker exec -i -u node "$NAME" node - < scripts/test/function-isolation-probe.cjs
