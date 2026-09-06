#!/usr/bin/env bash
# ============================================================================
# LEAVE A MAINTENANCE WINDOW
# ============================================================================
#
# Deliberately separate from scripts/maintenance-freeze.sh, and deliberately
# not run on any exit path from it. An interrupted migration must stay frozen:
# a freeze script that tidied up after itself would resurrect the application
# in the middle of a half-applied schema change.
#
# Starts from ecosystem.config.js so the app definition is the one in the
# repository, then compares what came back against the snapshot the freeze
# recorded, so a silently different configuration is visible rather than
# assumed.
#
# BACKENLY_EDITION is re-exported explicitly. An unset edition resolves to
# single-tenant and STARTS SILENTLY, which on a Cloud host means serving a
# multi-tenant database with single-tenant project rules.
#
# USAGE
#
#   scripts/maintenance-resume.sh <freeze-state.json>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE="${1:-}"
if [ -z "$STATE" ] || [ ! -f "$STATE" ]; then
  echo "maintenance-resume: FATAL: pass the freeze state file" >&2
  echo "  usage: scripts/maintenance-resume.sh .maintenance/freeze-<stamp>.json" >&2
  exit 2
fi

echo "maintenance-resume: snapshot $STATE"
EXPECTED_EDITION="$(node -e '
const s = require(process.argv[1])
const set = new Set(s.apps.map(a => a.backenly_edition))
console.log(set.size === 1 ? [...set][0] || "" : "")
' "$STATE")"

if [ -z "${BACKENLY_EDITION:-}" ]; then
  if [ -n "$EXPECTED_EDITION" ]; then
    export BACKENLY_EDITION="$EXPECTED_EDITION"
    echo "maintenance-resume: restoring BACKENLY_EDITION from the snapshot"
  elif [ -f "$ROOT/.env" ] && grep -q '^BACKENLY_EDITION=' "$ROOT/.env"; then
    BACKENLY_EDITION="$(grep -m1 '^BACKENLY_EDITION=' "$ROOT/.env" | cut -d= -f2- | tr -d '"'"'"'')"
    export BACKENLY_EDITION
    echo "maintenance-resume: restoring BACKENLY_EDITION from .env"
  else
    echo "maintenance-resume: FATAL: BACKENLY_EDITION is not set and not recoverable" >&2
    echo "  Refusing to start: unset resolves to single-tenant and starts silently." >&2
    exit 1
  fi
fi
echo "maintenance-resume: starting with BACKENLY_EDITION=$BACKENLY_EDITION"

pm2 start ecosystem.config.js --update-env 2>&1 | tail -5
sleep 5

echo
echo "maintenance-resume: verifying against the snapshot"
pm2 jlist 2>/dev/null | node -e '
let s = ""
process.stdin.on("data", d => (s += d)).on("end", () => {
  const live = JSON.parse(s || "[]")
  const snap = require(process.argv[1])
  let bad = 0
  for (const want of snap.apps) {
    const got = live.find(p => p.name === want.name)
    if (!got) { console.log(`  FAIL ${want.name} did not come back`); bad = 1; continue }
    const e = got.pm2_env
    const okStatus = e.status === "online"
    const okCron = (e.cron_restart || null) === want.cron_restart
    const okEdition = (e.BACKENLY_EDITION || null) === want.backenly_edition
    console.log(
      `  ${okStatus && okCron && okEdition ? "ok  " : "WARN"} ${want.name} ` +
      `status=${e.status} cron_restart=${e.cron_restart || null} ` +
      `edition=${e.BACKENLY_EDITION || "(unset)"}`
    )
    if (!okStatus) bad = 1
    if (!okCron) console.log(`       cron_restart differs from snapshot (${want.cron_restart})`)
    if (!okEdition) console.log(`       edition differs from snapshot (${want.backenly_edition})`)
  }
  process.exit(bad)
})' "$STATE"

echo
echo "maintenance-resume: RESUMED"
echo "  run 'pm2 save' once smoke tests pass, so a reboot cannot restore the pre-window state"
