#!/bin/sh
# ============================================================================
# Backenly image entrypoint: the function supervisor as root, the app as node.
# ============================================================================
#
# Customer function code must never run in a process that holds a platform
# secret, and the web and runtime processes hold all of them. So these images
# start as root (they have no USER line), and this script:
#
#   1. starts the function supervisor
#      (/opt/backenly-fn/function-supervisor.cjs) as root, with an EMPTY
#      environment plus its own settings, and starts it again if it exits. It
#      runs each function in a fresh process under a uid of its own.
#   2. runs the app (the image's CMD) as `node`, under no_new_privs, with a
#      umask that keeps every file the app writes from other uids.
#
# tini is PID 1 (the image's ENTRYPOINT runs this script under it), so it
# forwards SIGTERM to the app, which `exec` makes this process, and reaps
# whatever a killed function run leaves behind.
#
# Started as anything but root (a task definition, `docker run --user` or a
# compose `user:`), step 1 cannot happen: this says so and runs the app as it
# is, and functions then refuse to run with that reason. Nothing ever falls back
# to running function code in the app.
# ============================================================================
set -eu

FN_HOME=/opt/backenly-fn
APP_USER=node

if [ "$(id -u)" != "0" ]; then
  echo "backenly: started as uid $(id -u), not root, so the function supervisor cannot start; functions will refuse to run" >&2
  exec "$@"
fi

app_uid="$(id -u "$APP_USER")"
app_gid="$(id -g "$APP_USER")"
# The app's pid once `exec` below has run: the supervisor checks a function
# cannot read its environment.
app_pid=$$

# Every project's files and backups are the app's alone. /app is 0750 root:node
# in the image, which covers the default paths; this covers them set elsewhere.
for dir in "${WORKSPACE_DIR:-}" "${BACKUP_DIR:-}"; do
  if [ -n "$dir" ] && [ -d "$dir" ]; then
    chmod o-rwx "$dir" 2>/dev/null || echo "backenly: could not restrict $dir to its owner" >&2
  fi
done

supervise() {
  while :; do
    env -i \
      PATH=/usr/local/bin:/usr/bin:/bin \
      BACKENLY_FN_SOCKET="${BACKENLY_FN_SOCKET:-}" \
      BACKENLY_FN_SOCKET_GID="$app_gid" \
      BACKENLY_FN_RUNNER="$FN_HOME/function-runner.cjs" \
      BACKENLY_FN_NODE_ENV="${NODE_ENV:-production}" \
      BACKENLY_FN_CA_CERTS="${BACKENLY_FN_CA_CERTS:-}" \
      BACKENLY_FN_MAX_CONCURRENCY="${BACKENLY_FN_MAX_CONCURRENCY:-}" \
      BACKENLY_FN_MAX_QUEUE="${BACKENLY_FN_MAX_QUEUE:-}" \
      BACKENLY_FN_QUEUE_WAIT_MS="${BACKENLY_FN_QUEUE_WAIT_MS:-}" \
      BACKENLY_FN_HEAP_MB="${BACKENLY_FN_HEAP_MB:-}" \
      BACKENLY_FN_RSS_MB="${BACKENLY_FN_RSS_MB:-}" \
      BACKENLY_FN_NPROC="${BACKENLY_FN_NPROC:-}" \
      BACKENLY_FN_NOFILE="${BACKENLY_FN_NOFILE:-}" \
      BACKENLY_FN_FSIZE_MB="${BACKENLY_FN_FSIZE_MB:-}" \
      BACKENLY_FN_UID_BASE="${BACKENLY_FN_UID_BASE:-}" \
      BACKENLY_FN_UID_COUNT="${BACKENLY_FN_UID_COUNT:-}" \
      BACKENLY_FN_PROTECTED_PATHS="/app:${WORKSPACE_DIR:-}:${BACKUP_DIR:-}" \
      BACKENLY_FN_APP_PID="$app_pid" \
      /usr/local/bin/node "$FN_HOME/function-supervisor.cjs" || true
    echo "backenly: the function supervisor exited; starting it again" >&2
    sleep 1
  done
}
supervise &

umask 077
exec setpriv --reuid="$app_uid" --regid="$app_gid" --init-groups --no-new-privs -- "$@"
