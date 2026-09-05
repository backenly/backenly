#!/usr/bin/env bash
# ============================================================================
# A CLOUD DEPLOY WITHOUT ITS PRIVATE HALF MUST DIE BEFORE THE BUILD
# ============================================================================
#
# scripts/compose-cloud.sh is the step scripts/deploy.sh runs after `git pull`
# and before npm install, db:push, the build, the .next swap and the PM2
# restart. Everything it refuses is therefore refused while the live site is
# still serving the previous build.
#
# The failures worth proving are the ones that would otherwise be discovered
# late: a private repository this host cannot read, an overlay written against a
# different public commit, and an overlay that would overwrite public source.
# Each has to abort, and each has to abort HERE.
#
# Real git repositories over file:// remotes, not mocks. A mocked clone would
# prove that the mock returns what the test told it to.
#
# Production is never contacted: no host is reached, no PM2 process is touched,
# and deploy.sh itself is only ever read, never run.
#
# Run:  bash scripts/test/deploy-composition.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/scripts/compose-cloud.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -rf "$ROOT/lib/cloud" "$ROOT/config/cloud"' EXIT

PASS=0
FAIL=0
ok()  { echo "  ok    $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

PUBLIC_SHA="$(git -C "$ROOT" rev-parse HEAD)"
echo "deploy-composition: public HEAD $PUBLIC_SHA"

reset_tree() { rm -rf "$ROOT/lib/cloud" "$ROOT/config/cloud"; }

# A fixture private repo: PUBLIC_BASE_SHA plus an overlay/ tree.
# $1 name, $2 the sha to pin, $3.. overlay files as "relpath=content"
make_private_repo() {
  local name="$1" sha="$2"; shift 2
  local dir="$WORK/$name"
  rm -rf "$dir"; mkdir -p "$dir/overlay"
  printf '%s\n' "$sha" > "$dir/PUBLIC_BASE_SHA"
  for spec in "$@"; do
    local rel="${spec%%=*}" body="${spec#*=}"
    mkdir -p "$dir/overlay/$(dirname "$rel")"
    printf '%s\n' "$body" > "$dir/overlay/$rel"
  done
  git -C "$dir" init --quiet -b main
  git -C "$dir" -c user.email=t@t -c user.name=t add -A
  git -C "$dir" -c user.email=t@t -c user.name=t commit --quiet -m "fixture"
  echo "$dir"
}

VALID_MANIFEST='{ "schema": 1, "publicBaseSha": "'"$PUBLIC_SHA"'", "extension": "lib/cloud/extension.ts", "capabilities": ["presence"] }'

run_compose() {
  local edition="$1" repo="$2" dir="$3"
  ( cd "$ROOT" && env -u BACKENLY_CLOUD_REPO -u BACKENLY_CLOUD_REF -u BACKENLY_CLOUD_DIR \
      BACKENLY_EDITION="$edition" \
      BACKENLY_CLOUD_REPO="$repo" \
      BACKENLY_CLOUD_DIR="$dir" \
      bash "$COMPOSE" ) >"$WORK/out.log" 2>&1
}

# ---------------------------------------------------------------------------
echo
echo "A. single-tenant composes nothing and never reaches for the private repo"
# ---------------------------------------------------------------------------
reset_tree
# The repo URL is deliberately bogus. A self-hosted operator has no access to
# backenly-cloud, so any attempt to clone it would fail their deploy on a
# repository that is none of their business.
if run_compose single-tenant "file://$WORK/nope-does-not-exist" "$WORK/st-dir"; then
  ok "single-tenant exits 0"
else
  bad "single-tenant should exit 0"; cat "$WORK/out.log"
fi
if ! grep -qi "clon\|fetch" "$WORK/out.log"; then ok "single-tenant did not try to clone"; else bad "single-tenant tried to clone"; fi
if [ ! -d "$WORK/st-dir" ]; then ok "single-tenant created no private checkout"; else bad "single-tenant created a private checkout"; fi
if [ ! -e "$ROOT/lib/cloud" ]; then ok "single-tenant applied no overlay"; else bad "single-tenant applied an overlay"; fi

# ---------------------------------------------------------------------------
echo
echo "B. an unset edition is refused, not guessed"
# ---------------------------------------------------------------------------
reset_tree
if ( cd "$ROOT" && env -u BACKENLY_EDITION BACKENLY_CLOUD_DIR="$WORK/unset-dir" \
      BACKENLY_ENV_FILE_ABSENT=1 bash "$COMPOSE" ) >"$WORK/out.log" 2>&1; then
  # .env in a developer checkout may legitimately set the edition, in which case
  # this case cannot be exercised here and says so rather than asserting wrongly.
  if grep -qE "^compose-cloud: edition" "$WORK/out.log"; then
    ok "edition came from .env (unset-refusal not exercised in this checkout)"
  else
    bad "unset edition should have been refused"
  fi
else
  if grep -q "BACKENLY_EDITION is not set" "$WORK/out.log"; then ok "unset edition refused with a clear message"
  else bad "unset edition failed for the wrong reason"; cat "$WORK/out.log"; fi
fi

# ---------------------------------------------------------------------------
echo
echo "C. cloud with an unreachable private repository aborts"
# ---------------------------------------------------------------------------
reset_tree
if run_compose cloud "file://$WORK/definitely-not-a-repo" "$WORK/missing-dir"; then
  bad "unreachable private repo should have aborted"
else
  ok "unreachable private repo aborted"
fi
if grep -q "build has NOT started" "$WORK/out.log"; then ok "says the build has not started"; else bad "no build-not-started message"; fi
if [ ! -e "$ROOT/lib/cloud" ]; then ok "nothing composed"; else bad "something was composed"; fi

# ---------------------------------------------------------------------------
echo
echo "D. cloud with a mismatched PUBLIC_BASE_SHA aborts"
# ---------------------------------------------------------------------------
reset_tree
MISMATCH="$(make_private_repo mismatch "0000000000000000000000000000000000000000" \
  "lib/cloud/manifest.json=$VALID_MANIFEST" "lib/cloud/extension.ts=export const CLOUD = true")"
if run_compose cloud "file://$MISMATCH" "$WORK/mismatch-dir"; then
  bad "SHA mismatch should have aborted"
else
  ok "SHA mismatch aborted"
fi
if grep -q "not a matching pair" "$WORK/out.log"; then ok "names the mismatch explicitly"; else bad "mismatch message missing"; cat "$WORK/out.log"; fi
if [ ! -e "$ROOT/lib/cloud" ]; then ok "no overlay applied on mismatch"; else bad "overlay applied despite mismatch"; fi

# ---------------------------------------------------------------------------
echo
echo "E. cloud with an overlay that would clobber public source aborts"
# ---------------------------------------------------------------------------
reset_tree
CLOBBER="$(make_private_repo clobber "$PUBLIC_SHA" \
  "lib/cloud/manifest.json=$VALID_MANIFEST" \
  "lib/cloud/extension.ts=export const CLOUD = true" \
  "lib/billing/index.ts=// clobbered")"
if run_compose cloud "file://$CLOBBER" "$WORK/clobber-dir"; then
  bad "clobbering overlay should have aborted"
else
  ok "clobbering overlay aborted"
fi
if [ ! -e "$ROOT/lib/cloud/extension.ts" ]; then ok "atomic: the valid file was not applied either"
else bad "PARTIAL COMPOSITION: a valid overlay file was applied"; fi
if git -C "$ROOT" diff --quiet -- lib/billing/index.ts; then ok "public source untouched"; else bad "PUBLIC SOURCE MODIFIED"; fi

# ---------------------------------------------------------------------------
echo
echo "F. cloud with a matching, valid overlay composes"
# ---------------------------------------------------------------------------
reset_tree
GOOD="$(make_private_repo good "$PUBLIC_SHA" \
  "lib/cloud/manifest.json=$VALID_MANIFEST" \
  "lib/cloud/extension.ts=export const CLOUD = true")"
if run_compose cloud "file://$GOOD" "$WORK/good-dir"; then
  ok "matching pair composes"
else
  bad "matching pair should compose"; cat "$WORK/out.log"
fi
if [ -f "$ROOT/lib/cloud/manifest.json" ]; then ok "overlay applied"; else bad "overlay not applied"; fi

# The composed tree must satisfy the runtime assertion the servers make, or the
# deploy would succeed and the processes would still refuse to start.
if ( cd "$ROOT" && BACKENLY_EDITION=cloud node node_modules/tsx/dist/cli.mjs \
      scripts/verify-cloud-composition.ts --expect present ) >/dev/null 2>&1; then
  ok "composed tree satisfies the runtime fail-closed assertion"
else
  bad "composed tree does not satisfy the runtime assertion"
fi

# Re-running a deploy must be safe.
if run_compose cloud "file://$GOOD" "$WORK/good-dir"; then ok "re-composing an existing checkout succeeds"
else bad "re-compose failed"; cat "$WORK/out.log"; fi

reset_tree

# ---------------------------------------------------------------------------
echo
echo "G. deploy.sh composes before it builds, swaps or restarts"
# ---------------------------------------------------------------------------
# Ordering is the whole safety property: a composition failure must land while
# the previous build is still serving. This asserts the order in the script
# rather than running it, because running it would deploy.
line_of() { grep -n "$1" "$ROOT/scripts/deploy.sh" | head -1 | cut -d: -f1; }
COMPOSE_AT=$(line_of 'bash scripts/compose-cloud.sh')
INSTALL_AT=$(line_of 'npm install --no-audit')
BUILD_AT=$(line_of 'npm run build')
SWAP_AT=$(line_of 'mv "\$STAGING" "\$LIVE"')
RESTART_AT=$(line_of 'pm2 restart')

if [ -n "$COMPOSE_AT" ]; then ok "deploy.sh calls compose-cloud.sh"; else bad "deploy.sh never composes"; fi
for pair in "INSTALL_AT:npm install" "BUILD_AT:the build" "SWAP_AT:the .next swap" "RESTART_AT:the PM2 restart"; do
  var="${pair%%:*}"; label="${pair#*:}"
  val="${!var}"
  if [ -n "$COMPOSE_AT" ] && [ -n "$val" ] && [ "$COMPOSE_AT" -lt "$val" ]; then
    ok "composition precedes $label"
  else
    bad "composition does NOT precede $label"
  fi
done

echo
echo "deploy-composition: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
