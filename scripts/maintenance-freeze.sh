#!/usr/bin/env bash
# ============================================================================
# FREEZE THE APPLICATION FOR A MAINTENANCE WINDOW
# ============================================================================
#
# `pm2 stop` IS NOT A FREEZE.
#
# On 2026-09-06, during the Stage A database migration, both application
# processes were stopped at 12:12Z. At 12:37Z PM2 restarted backenly-runtime by
# itself, because ecosystem.config.js gives it `cron_restart: '37 */12 * * *'`
# and PM2's cron fires against a STOPPED process. The write freeze had silently
# ended, and nothing said so: a cron restart does not increment the restart
# counter, so `pm2 list` looked untouched.
#
# The migration happened to be safe (no rows changed in those seven minutes),
# but a backup taken "after writes stopped" was, for a while, not that.
#
# So this does not stop the processes. It DELETES them from PM2, which is the
# only state in which neither `cron_restart` nor `autorestart` can bring them
# back, and then proves they are gone and stay gone across a cron boundary.
#
# Resuming is a SEPARATE, EXPLICIT operation: scripts/maintenance-resume.sh.
# Nothing here re-enables anything on exit, because an interrupted migration
# must stay frozen rather than quietly resurrect mid-write.
#
# PostgREST is deliberately NOT frozen. It has no scheduler and initiates no
# writes of its own; it only executes requests from the two application
# processes, which are gone. Freezing it would take the customer data plane
# down for no additional safety.
#
# USAGE
#
#   scripts/maintenance-freeze.sh [--wait SECONDS] [--apps "a b"]
#
#   --wait   seconds to wait before re-verifying, default 65 so the check
#            crosses a minute boundary and would observe a per-minute cron.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WAIT=65
APPS="backenly-nextjs backenly-runtime"

while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT="$2"; shift 2 ;;
    --apps) APPS="$2"; shift 2 ;;
    -h|--help) sed -n '1,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "maintenance-freeze: unknown option $1" >&2; exit 2 ;;
  esac
done

# Fail before writing anything. Without this, a missing pm2 produced an empty
# snapshot file and only then aborted, leaving a state file that claims the
# window froze nothing.
if ! command -v pm2 >/dev/null 2>&1; then
  echo "maintenance-freeze: FATAL: pm2 is not on PATH" >&2
  exit 1
fi
if ! pm2 jlist >/dev/null 2>&1; then
  echo "maintenance-freeze: FATAL: 'pm2 jlist' failed, refusing to freeze blind" >&2
  exit 1
fi

STATE_DIR="${BACKENLY_MAINTENANCE_DIR:-$ROOT/.maintenance}"
mkdir -p "$STATE_DIR"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
STATE="$STATE_DIR/freeze-$STAMP.json"

# ---------------------------------------------------------------------------
# 1. Snapshot what we are about to delete, so resume reinstates the observed
#    configuration rather than assuming defaults. Non-secret fields only.
# ---------------------------------------------------------------------------
echo "maintenance-freeze: snapshotting current PM2 state"
pm2 jlist 2>/dev/null | node -e '
let s = ""
process.stdin.on("data", d => (s += d)).on("end", () => {
  const wanted = process.argv[1].split(/\s+/).filter(Boolean)
  const apps = JSON.parse(s || "[]")
    .filter(p => wanted.includes(p.name))
    .map(p => ({
      name: p.name,
      pm_id: p.pm_id,
      status: p.pm2_env.status,
      restart_time: p.pm2_env.restart_time,
      cron_restart: p.pm2_env.cron_restart || null,
      autorestart: p.pm2_env.autorestart,
      exec_path: p.pm2_env.pm_exec_path,
      cwd: p.pm2_env.pm_cwd,
      // Recorded because losing it is the dangerous failure mode.
      backenly_edition: p.pm2_env.BACKENLY_EDITION || null,
    }))
  console.log(JSON.stringify({ frozen_at: process.argv[2], apps }, null, 2))
})' "$APPS" "$STAMP" > "$STATE"

echo "maintenance-freeze: state written to $STATE"
node -e '
const s = require(process.argv[1])
for (const a of s.apps) {
  console.log(`  ${a.name}  id=${a.pm_id}  ${a.status}  restarts=${a.restart_time}  cron_restart=${a.cron_restart}  autorestart=${a.autorestart}  edition=${a.backenly_edition}`)
}
if (!s.apps.length) console.log("  (no matching PM2 apps found)")
' "$STATE"

# ---------------------------------------------------------------------------
# 2. Delete. Stopping is not enough: PM2's cron fires on stopped processes.
# ---------------------------------------------------------------------------
for app in $APPS; do
  if pm2 describe "$app" >/dev/null 2>&1; then
    echo "maintenance-freeze: deleting $app from PM2 (removes cron_restart and autorestart)"
    pm2 delete "$app" >/dev/null 2>&1 || true
  else
    echo "maintenance-freeze: $app is not registered with PM2"
  fi
done

# ---------------------------------------------------------------------------
# 3. Prove the postcondition rather than assume it.
# ---------------------------------------------------------------------------
verify() {
  local phase="$1" failed=0
  for app in $APPS; do
    if pm2 describe "$app" >/dev/null 2>&1; then
      echo "  $phase: FAIL $app is still registered with PM2"
      failed=1
    else
      echo "  $phase: ok   $app absent from PM2"
    fi
  done
  return $failed
}

echo "maintenance-freeze: verifying"
verify "immediate" || { echo "maintenance-freeze: FROZEN STATE NOT REACHED" >&2; exit 1; }

echo "maintenance-freeze: waiting ${WAIT}s to cross a cron boundary"
sleep "$WAIT"

verify "after ${WAIT}s" || {
  echo "maintenance-freeze: A PROCESS CAME BACK DURING THE WINDOW" >&2
  echo "maintenance-freeze: DO NOT PROCEED WITH DATABASE WORK" >&2
  exit 1
}

echo
echo "maintenance-freeze: FROZEN"
echo "  resume with: scripts/maintenance-resume.sh $STATE"
