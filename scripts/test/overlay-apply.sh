#!/usr/bin/env bash
# ============================================================================
# THE OVERLAY IS ADD-ONLY, AND A REFUSAL COPIES NOTHING
# ============================================================================
#
# scripts/apply-overlay.sh composes Backenly Cloud: the public checkout plus a
# private overlay that only ever CREATES files. Two properties matter, and
# neither is visible from reading the script:
#
#   1. It refuses anything that would overwrite public source, land outside the
#      allowlist, or escape through a symlink.
#   2. A refusal leaves the tree EXACTLY as it found it. Validation runs over
#      every file before the first copy, so a half-applied overlay is not a
#      state the script can produce. That is the property this file exists for:
#      testing only that "the bad file was rejected" would pass just as happily
#      against a script that copied three good files first and then stopped.
#
# A jest test cannot do this. The subject is a shell script driving cp, find and
# git against a real working tree.
#
# Run:  bash scripts/test/overlay-apply.sh
#
# Symlink escape needs a filesystem that can make symlinks. Windows without
# developer mode cannot, so that one case skips there and runs on Linux CI. Set
# OVERLAY_APPLY_REQUIRE=1 to turn that skip into a failure, which is what CI
# does, so a green tick there cannot mean "checked nothing".

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPLY="$ROOT/scripts/apply-overlay.sh"
REQUIRE="${OVERLAY_APPLY_REQUIRE:-0}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -rf "$ROOT/lib/cloud" "$ROOT/config/cloud"' EXIT

PASS=0
FAIL=0

ok()   { echo "  ok    $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
skip() {
  if [ "$REQUIRE" = "1" ]; then
    echo "  FAIL  $1 (skipped, but OVERLAY_APPLY_REQUIRE=1)"
    FAIL=$((FAIL + 1))
  else
    echo "  skip  $1"
  fi
}

# Every case starts from a tree with no composed overlay in it.
reset_tree() { rm -rf "$ROOT/lib/cloud" "$ROOT/config/cloud"; }

mkoverlay() {
  local name="$1"
  rm -rf "${WORK:?}/$name"
  mkdir -p "$WORK/$name/overlay"
  echo "$WORK/$name"
}

put() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  shift
  printf '%s\n' "$*" > "$path"
}

# The tracked-file state of the public repo must be identical before and after
# every case. This is the real assertion behind "changes nothing".
tracked_state() { git -C "$ROOT" status --porcelain --untracked-files=no | LC_ALL=C sort; }

BASELINE="$(tracked_state)"

expect_tracked_unchanged() {
  if [ "$(tracked_state)" = "$BASELINE" ]; then ok "$1: tracked public files unchanged"
  else bad "$1: TRACKED PUBLIC FILES CHANGED"; fi
}

echo "overlay-apply: $ROOT"

# ---------------------------------------------------------------------------
echo
echo "1. an empty overlay is a no-op"
# ---------------------------------------------------------------------------
reset_tree
SRC="$(mkoverlay empty)"
if bash "$APPLY" "$SRC" >/dev/null 2>&1; then ok "empty overlay exits 0"; else bad "empty overlay should exit 0"; fi
expect_tracked_unchanged "empty overlay"
if [ ! -d "$ROOT/lib/cloud" ]; then ok "empty overlay created nothing"; else bad "empty overlay created files"; fi

# ---------------------------------------------------------------------------
echo
echo "2. a valid overlay applies"
# ---------------------------------------------------------------------------
reset_tree
SRC="$(mkoverlay valid)"
put "$SRC/overlay/lib/cloud/manifest.json" '{ "schema": 1, "publicBaseSha": "0000000000000000000000000000000000000000", "extension": "lib/cloud/extension.ts", "capabilities": [] }'
put "$SRC/overlay/lib/cloud/extension.ts" 'export const CLOUD = true'
if bash "$APPLY" "$SRC" >/dev/null 2>&1; then ok "valid overlay exits 0"; else bad "valid overlay should exit 0"; fi
if [ -f "$ROOT/lib/cloud/extension.ts" ]; then ok "valid overlay created its files"; else bad "valid overlay created nothing"; fi
expect_tracked_unchanged "valid overlay"

# The composed files must be invisible to git, or every Cloud checkout looks
# dirty and the next deploy's pull has to reason about it.
if [ -z "$(git -C "$ROOT" status --porcelain -- lib/cloud)" ]; then ok "composed files are ignored by git"
else bad "composed files show up as repository changes"; fi

# ---------------------------------------------------------------------------
echo
echo "3. re-applying the same overlay is idempotent"
# ---------------------------------------------------------------------------
put "$SRC/overlay/lib/cloud/extension.ts" 'export const CLOUD = true // v2'
if bash "$APPLY" "$SRC" >/dev/null 2>&1; then ok "second apply exits 0"; else bad "second apply should exit 0"; fi
if grep -q 'v2' "$ROOT/lib/cloud/extension.ts"; then ok "second apply refreshed its own untracked file"
else bad "second apply did not update the overlay-owned file"; fi
expect_tracked_unchanged "second apply"

# ---------------------------------------------------------------------------
echo
echo "4. ATOMIC REFUSAL: one bad file means nothing is copied"
# ---------------------------------------------------------------------------
# The good file sorts before the bad one, so any implementation that wrote as it
# walked would already have created it by the time it reached the collision.
#
# This case is settled by the ownership verifier, which runs over the whole
# overlay before the file loop is reached. Case 7 covers the other half: a
# refusal raised AFTER the verifier has passed, which is the stage where a
# write-as-you-go implementation would actually leak a file.
reset_tree
SRC="$(mkoverlay atomic)"
put "$SRC/overlay/lib/cloud/aaa-good.ts" 'export const GOOD = 1'
put "$SRC/overlay/lib/billing/index.ts" '// would clobber public source'
if bash "$APPLY" "$SRC" >/dev/null 2>&1; then bad "collision should have been refused"; else ok "collision refused (non-zero exit)"; fi
if [ ! -e "$ROOT/lib/cloud/aaa-good.ts" ]; then ok "NO PARTIAL COPY: the valid file was not written"
else bad "PARTIAL COPY: a valid file was written before the refusal"; fi
expect_tracked_unchanged "atomic refusal"

# ---------------------------------------------------------------------------
echo
echo "5. an overlay file outside the allowlist is refused"
# ---------------------------------------------------------------------------
reset_tree
SRC="$(mkoverlay outside)"
put "$SRC/overlay/lib/ai/brain/agent.ts" '// public product code'
if bash "$APPLY" "$SRC" >/dev/null 2>&1; then bad "out-of-allowlist should have been refused"; else ok "out-of-allowlist refused"; fi
expect_tracked_unchanged "out-of-allowlist"

# ---------------------------------------------------------------------------
echo
echo "6. shared single-copy infrastructure is refused"
# ---------------------------------------------------------------------------
for shared in package.json prisma/schema.prisma middleware.ts app/layout.tsx; do
  reset_tree
  SRC="$(mkoverlay "shared-$(echo "$shared" | tr '/.' '--')")"
  put "$SRC/overlay/$shared" '// second copy'
  if bash "$APPLY" "$SRC" >/dev/null 2>&1; then bad "overlay of $shared should have been refused"
  else ok "overlay of $shared refused"; fi
done
expect_tracked_unchanged "shared infrastructure"

# ---------------------------------------------------------------------------
echo
echo "7. a symlink is refused rather than followed"
# ---------------------------------------------------------------------------
# This is the escape a path check alone does not catch: the destination reads as
# an allowlisted private path while the link target is anywhere on the disk, and
# cp would happily follow it.
reset_tree
SRC="$(mkoverlay symlink)"
mkdir -p "$SRC/overlay/lib/cloud"
# A companion regular file, so this doubles as the atomicity case that case 4
# cannot be. Every path here is allowlisted and untracked, so the ownership
# verifier PASSES the whole overlay; the refusal is raised afterwards, in the
# stage where an implementation that copied as it validated would already have
# written aaa-good.ts. Its absence is what proves the copy phase is separate.
put "$SRC/overlay/lib/cloud/aaa-good.ts" 'export const GOOD = 1'
if ln -s /etc/hostname "$SRC/overlay/lib/cloud/escape.json" 2>/dev/null && [ -L "$SRC/overlay/lib/cloud/escape.json" ]; then
  if bash "$APPLY" "$SRC" >/dev/null 2>&1; then bad "symlink should have been refused"; else ok "symlink refused"; fi
  if [ ! -e "$ROOT/lib/cloud/escape.json" ]; then ok "symlink target was not copied in"; else bad "symlink was followed"; fi
  if [ ! -e "$ROOT/lib/cloud/aaa-good.ts" ]; then ok "NO PARTIAL COPY after the verifier passed"
  else bad "PARTIAL COPY: a valid file was written before the symlink refusal"; fi
  expect_tracked_unchanged "symlink"
else
  skip "symlink escape (this filesystem cannot create symlinks)"
  skip "no-partial-copy after the verifier passes (needs the symlink case)"
fi

# ---------------------------------------------------------------------------
echo
echo "8. a missing source is refused, not silently ignored"
# ---------------------------------------------------------------------------
reset_tree
if bash "$APPLY" "$WORK/does-not-exist" >/dev/null 2>&1; then bad "missing source should have been refused"
else ok "missing source refused"; fi
if bash "$APPLY" >/dev/null 2>&1; then bad "missing argument should have been refused"; else ok "missing argument refused"; fi

# ---------------------------------------------------------------------------
echo
echo "9. --dry-run validates without writing"
# ---------------------------------------------------------------------------
reset_tree
SRC="$(mkoverlay dryrun)"
put "$SRC/overlay/lib/cloud/manifest.json" '{ "schema": 1, "publicBaseSha": "0000000000000000000000000000000000000000", "extension": "lib/cloud/extension.ts", "capabilities": [] }'
put "$SRC/overlay/lib/cloud/extension.ts" 'export const CLOUD = true'
if bash "$APPLY" "$SRC" --dry-run >/dev/null 2>&1; then ok "dry run exits 0"; else bad "dry run should exit 0"; fi
if [ ! -e "$ROOT/lib/cloud/manifest.json" ]; then ok "dry run wrote nothing"; else bad "dry run wrote files"; fi

reset_tree

echo
echo "overlay-apply: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
