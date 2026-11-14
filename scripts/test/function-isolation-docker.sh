#!/usr/bin/env bash
# ============================================================================
# FUNCTION ISOLATION, PROVEN AGAINST A BUILT IMAGE
# ============================================================================
# Function code must never run in a process that holds a platform secret.
# The images start as root, start the function supervisor, and run the app as
# `node`; the supervisor runs each function as a uid of its own
# (lib/services/ai-functions/isolation/).
#
# This starts the image as ECS Fargate does: its own ENTRYPOINT and CMD, no
# --user, no added capabilities, the default seccomp profile. Planted values
# stand where the platform's secrets go, and the two volumes are mounted
# outside /app, owned by node, as EFS access points present them. Then it
# checks, from inside the running container (scripts/test/function-isolation-
# probe.cjs): tini is PID 1, the supervisor runs as root with nothing but its
# own settings in its environment, the app runs as node; and, through the real
# supervisor, that function runs get pool uids of their own and can read no
# other process's environment, /app, either volume or the supervisor socket,
# that the known escapes return nothing secret, and that a run past its
# deadline, or over its memory, is killed and leaves nothing behind. From
# outside: a command override (as one-off tasks use) runs as node and exits
# with the command's code, SIGTERM stops the container promptly, and a second
# container on a read-only root with /tmp as tmpfs (docker/compose.stack.yml)
# runs functions the same way.
#
#   bash scripts/test/function-isolation-docker.sh            builds docker/runtime.Dockerfile
#   bash scripts/test/function-isolation-docker.sh <image>    an image already built (web or runtime)
#
# The web image is not built here: `next build` needs far more memory than a
# small builder has. It runs the same entrypoint, supervisor and runner, which
# the runtime image carries too; pass a web image built elsewhere by name.
#
# The app starts with an unreachable database URL, which neither image needs
# to come up. Needs Docker; exits non-zero on any failure.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/../.."

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  IMAGE=backenly-runtime:function-isolation-test
  docker build --platform linux/amd64 -f docker/runtime.Dockerfile -t "$IMAGE" .
fi

NAME="backenly-fn-isolation-$$"
cleanup() { docker rm -f "$NAME" "$NAME-ro" >/dev/null 2>&1 || true; }
trap cleanup EXIT

FAILED=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=$((FAILED + 1)); }

# Planted values: a run must never see any of them. The database URL is
# assembled so no scanner reads a fixture as a credential.
DB_URL="postgresql://planted:planted-not-a-real-password"
DB_URL="${DB_URL}@127.0.0.1:1/planted"
RUN_ARGS=(
  -e JWT_SECRET=planted-not-a-real-jwt-secret-docker
  -e MASTER_ENCRYPTION_KEY=planted-not-a-real-master-key-docker
  -e ENV_VAR_ENCRYPTION_KEY=planted-not-a-real-env-key-docker
  -e STRIPE_SECRET_KEY=planted-not-a-real-stripe-key-docker
  -e INTERNAL_API_TOKEN=planted-not-a-real-internal-token-docker
  -e DATABASE_URL="$DB_URL"
  -e CORS_ORIGIN=http://localhost
  # The volumes, outside /app and owned by node, as an EFS access point
  # presents them; the entrypoint must close them to other uids itself.
  -e WORKSPACE_DIR=/srv/workspace
  -e BACKUP_DIR=/srv/backups
  --tmpfs /srv/workspace:rw,uid=1000,gid=1000,mode=0755
  --tmpfs /srv/backups:rw,uid=1000,gid=1000,mode=0755
)

# Until the supervisor's socket exists, or the container has stopped.
wait_for_supervisor() {
  for _ in $(seq 1 60); do
    if docker exec "$1" test -S /tmp/backenly-fn/supervisor.sock 2>/dev/null; then return 0; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ] || return 1
    sleep 1
  done
  return 1
}

check_supervisor_log() {
  local log
  log="$(docker logs "$1" 2>&1)"
  echo "$log" | grep -E '^(function-supervisor|backenly):' | sed 's/^/   /' || true
  if echo "$log" | grep -q 'function-supervisor: listening on'; then pass "$2: the supervisor logged that it is listening"; else fail "$2: the supervisor never logged that it is listening"; fi
  if echo "$log" | grep -q 'REFUSING'; then fail "$2: the supervisor refused to run functions (its reason is above)"; else pass "$2: the supervisor never logged REFUSING"; fi
}

echo "── the image, started as Fargate starts it: $IMAGE"
docker run -d --name "$NAME" "${RUN_ARGS[@]}" "$IMAGE" >/dev/null
if ! wait_for_supervisor "$NAME"; then
  docker logs "$NAME" 2>&1 | tail -n 40 | sed 's/^/   /'
  echo "FAIL  the supervisor's socket never appeared"
  exit 1
fi
sleep 3
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = "true" ]; then pass "the app came up and stays up"; else fail "the container stopped on its own"; fi
check_supervisor_log "$NAME" "writable root"

echo "── as root inside it: what runs, as whom, with what"
docker exec -i -e PROBE_MODE=processes "$NAME" node - < scripts/test/function-isolation-probe.cjs || FAILED=$((FAILED + 1))

echo "── as the app user: function runs through the supervisor"
docker exec -i -u node "$NAME" node - < scripts/test/function-isolation-probe.cjs || FAILED=$((FAILED + 1))

echo "── a command override, as a one-off task runs it"
OVERRIDE_UID="$(docker run --rm "$IMAGE" node -e 'console.log(process.getuid())' 2>/dev/null || true)"
if [ "$OVERRIDE_UID" = "1000" ]; then pass "node -e 'console.log(process.getuid())' printed 1000"; else fail "node -e 'console.log(process.getuid())' printed '$OVERRIDE_UID', not 1000"; fi
set +e
docker run --rm "$IMAGE" node -e 'process.exit(7)' >/dev/null 2>&1
OVERRIDE_CODE=$?
set -e
if [ "$OVERRIDE_CODE" = "7" ]; then pass "the container exited with the command's own code (7)"; else fail "the container exited with $OVERRIDE_CODE, not the command's 7"; fi

echo "── SIGTERM"
STOP_START=$(date +%s%N)
docker stop -t 10 "$NAME" >/dev/null
STOP_MS=$(( ($(date +%s%N) - STOP_START) / 1000000 ))
STOP_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
docker logs "$NAME" 2>&1 | grep -iE 'SIGTERM|shutting down|closed' | sed 's/^/   /' || true
if [ "$STOP_MS" -lt 5000 ] && [ "$STOP_CODE" != "137" ]; then
  pass "docker stop took ${STOP_MS} ms, and the app exited with ${STOP_CODE} (not killed)"
else
  fail "docker stop took ${STOP_MS} ms and the container exited with ${STOP_CODE}: SIGTERM did not reach the app"
fi

echo "── again on a read-only root, /tmp a tmpfs (docker/compose.stack.yml)"
docker run -d --name "$NAME-ro" --read-only --tmpfs /tmp:rw,mode=1777 "${RUN_ARGS[@]}" "$IMAGE" >/dev/null
if wait_for_supervisor "$NAME-ro"; then
  sleep 3
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME-ro")" = "true" ]; then pass "read-only root: the app came up and stays up"; else fail "read-only root: the container stopped on its own"; fi
  check_supervisor_log "$NAME-ro" "read-only root"
  docker exec -i -u node -e PROBE_MODE=quick "$NAME-ro" node - < scripts/test/function-isolation-probe.cjs || FAILED=$((FAILED + 1))
else
  docker logs "$NAME-ro" 2>&1 | tail -n 40 | sed 's/^/   /'
  fail "read-only root: the supervisor's socket never appeared"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "every check passed"; else echo "$FAILED check group(s) FAILED"; fi
exit $(( FAILED > 0 ? 1 : 0 ))
