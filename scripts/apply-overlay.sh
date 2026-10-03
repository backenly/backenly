#!/usr/bin/env bash
# ============================================================================
# APPLY THE PRIVATE CLOUD OVERLAY ONTO THIS PUBLIC CHECKOUT
# ============================================================================
#
# Backenly Cloud is this public repository plus a private add-only overlay
# (backenly/backenly-cloud). The overlay CREATES files at paths that
# overlay-allowlist.json reserves for it. It never overwrites public source.
#
#   overlay/<relative-path>   ->   <public-repo-root>/<relative-path>
#
# WHY ADD-ONLY IS THE WHOLE POINT
#
# If the overlay could replace a tracked public file, the public repository
# would stop being a truthful description of what Cloud runs. A reader of the
# OSS tree could no longer tell which behaviour is theirs, and "read the source"
# would quietly become false. There is no legitimate "Cloud version" of a public
# module: the public module calls a seam, and the private extension contributes
# behaviour through it.
#
# WHY VALIDATION IS COMPLETE BEFORE ANY COPY
#
# A half-applied overlay is worse than a refused one. It leaves a checkout that
# is neither the public product nor Cloud, and the next build succeeds against
# it. So this script enumerates every overlay file, validates all of them, and
# only then copies. A refusal copies nothing at all.
#
# USAGE
#
#   scripts/apply-overlay.sh <overlay-dir-or-private-repo> [--dry-run]
#
# Either the overlay directory itself, or a private repo checkout containing
# one, is accepted:
#
#   scripts/apply-overlay.sh /srv/backenly-cloud
#   scripts/apply-overlay.sh /srv/backenly-cloud/overlay
#
# This script does NOT fetch anything. Obtaining the private repository is the
# caller's job (scripts/deploy.sh does it), so that credentials stay in the
# operator's environment and never in this file.

set -euo pipefail

# Resolve the public checkout from this script's own location. Deriving it makes
# the script correct on every host; a caller in any cwd gets the same answer.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "usage: scripts/apply-overlay.sh <overlay-dir-or-private-repo> [--dry-run]" >&2
}

SOURCE=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "apply-overlay: unknown option $arg" >&2; usage; exit 2 ;;
    *)
      if [ -n "$SOURCE" ]; then echo "apply-overlay: more than one source given" >&2; exit 2; fi
      SOURCE="$arg"
      ;;
  esac
done

if [ -z "$SOURCE" ]; then usage; exit 2; fi
if [ ! -d "$SOURCE" ]; then
  echo "apply-overlay: not a directory: $SOURCE" >&2
  exit 1
fi

SOURCE="$(cd "$SOURCE" && pwd)"

# Accept a private repo checkout or the overlay directory itself. A repo with an
# overlay/ subdirectory always means that subdirectory: a private repo root also
# holds README.md and .github/, and treating those as overlay content would try
# to write a public README.
if [ -d "$SOURCE/overlay" ]; then
  OVERLAY="$SOURCE/overlay"
else
  OVERLAY="$SOURCE"
fi

echo "apply-overlay: public root  $ROOT"
echo "apply-overlay: overlay      $OVERLAY"

# ---------------------------------------------------------------------------
# 1. Ownership boundary, by the one authority that already exists
# ---------------------------------------------------------------------------
#
# Phase 4's verifier owns the question "may the overlay own this path". Asking
# it here rather than reimplementing the rules keeps a single source of truth;
# a second allowlist would drift and the drift would be a security hole.
# Run it FROM the public root: the verifier resolves the allowlist and asks
# `git ls-files` relative to its own cwd, so invoking it from anywhere else
# would have it judge the overlay against the wrong repository.
if ! (cd "$ROOT" && node node_modules/tsx/dist/cli.mjs scripts/verify-overlay-boundary.ts --overlay "$OVERLAY"); then
  echo "apply-overlay: REFUSED - overlay violates the ownership boundary. Nothing copied." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Full preflight over every file, before touching the working tree
# ---------------------------------------------------------------------------

# `find -type f` deliberately does not match symlinks, so they are enumerated
# separately and refused. A symlink is how an add-only copy escapes: the
# destination path looks allowlisted while the link target is anywhere at all,
# and `cp` would follow it.
SYMLINKS="$(find "$OVERLAY" -type l -printf '%P\n' 2>/dev/null || true)"
if [ -n "$SYMLINKS" ]; then
  echo "apply-overlay: REFUSED - overlay contains symlinks. Nothing copied." >&2
  echo "$SYMLINKS" | sed 's/^/  /' >&2
  exit 1
fi

FILES="$(cd "$OVERLAY" && find . -type f -printf '%P\n' 2>/dev/null | LC_ALL=C sort || true)"

VALIDATED=0
PROBLEMS=""

if [ -n "$FILES" ]; then
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue

    # Skip private-repo bookkeeping if the overlay dir happens to carry it.
    case "$rel" in
      .git/*) continue ;;
    esac

    # Traversal and absolute paths. find(1) cannot normally produce either, but
    # the check is cheap and this is the boundary that matters most.
    case "$rel" in
      /*)      PROBLEMS+="  absolute path: $rel"$'\n'; continue ;;
      ..|../*|*/../*|*/..) PROBLEMS+="  path escapes the overlay: $rel"$'\n'; continue ;;
    esac

    # The invariant. Tracked means the public repository owns it, and no
    # overlay file may land on one.
    if git -C "$ROOT" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
      PROBLEMS+="  would overwrite tracked public file: $rel"$'\n'
      continue
    fi

    VALIDATED=$((VALIDATED + 1))
  done <<< "$FILES"
fi

if [ -n "$PROBLEMS" ]; then
  echo "apply-overlay: REFUSED - overlay would not be add-only. Nothing copied." >&2
  printf '%s' "$PROBLEMS" >&2
  exit 1
fi

echo "apply-overlay: validated    $VALIDATED file(s)"

if [ "$DRY_RUN" = "1" ]; then
  echo "apply-overlay: dry run, nothing written"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Copy. Only reached when every file passed.
# ---------------------------------------------------------------------------
#
# Re-applying the same overlay updates the untracked files it owns, which is
# what makes a redeploy idempotent. It can never touch a tracked public file:
# every destination was proven untracked above.
APPLIED=0
if [ -n "$FILES" ]; then
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in .git/*) continue ;; esac

    dest="$ROOT/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$OVERLAY/$rel" "$dest"
    APPLIED=$((APPLIED + 1))
  done <<< "$FILES"
fi

echo "apply-overlay: applied      $APPLIED file(s)"
echo "apply-overlay: OK"
