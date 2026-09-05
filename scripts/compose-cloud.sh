#!/usr/bin/env bash
# ============================================================================
# COMPOSE THIS CHECKOUT FOR THE EDITION IT IS ABOUT TO BUILD
# ============================================================================
#
# Backenly ships as two editions from one public repository:
#
#   single-tenant   the public repository, alone. Nothing to compose.
#   cloud           the public repository PLUS the private add-only overlay
#                   from backenly/backenly-cloud.
#
# A cloud build that is missing its private half must never reach `npm run
# build`. If it did, the resulting bundle would start, fail the runtime
# assertion in lib/edition/cloud-extension.ts, and crash-loop in production for
# a reason that was knowable minutes earlier on the deploy host. Worse, anything
# that skipped that assertion would resolve projects with single-tenant rules
# against a multi-tenant database.
#
# So this runs BEFORE dependencies, schema sync, build, swap and restart. Every
# failure here aborts with the live site untouched.
#
# USAGE
#
#   scripts/compose-cloud.sh            compose for the configured edition
#   scripts/compose-cloud.sh --check    validate only, apply nothing
#
# CONFIGURATION (environment, or .env in the checkout)
#
#   BACKENLY_EDITION      cloud | single-tenant   (REQUIRED, never guessed)
#   BACKENLY_CLOUD_REPO   private repo URL        (default: the canonical one)
#   BACKENLY_CLOUD_REF    branch or tag           (default: main)
#   BACKENLY_CLOUD_DIR    where to keep it        (default: sibling of checkout)
#
# CREDENTIALS
#
# None are read, written or printed here. Authentication for the private clone
# comes from the operator's own git configuration: an SSH deploy key, a
# credential helper, or a machine that is already authorised. The repository URL
# is not a secret; access to it is.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) echo "usage: scripts/compose-cloud.sh [--check]"; exit 0 ;;
    *) echo "compose-cloud: unknown option $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Which edition? Never inferred.
# ---------------------------------------------------------------------------
#
# The running processes read .env through dotenv, so that file is what actually
# decides the edition in production; an operator's shell may know nothing about
# it. The environment still wins when set, which is what makes this testable.
#
# An UNSET edition is refused rather than defaulted. The code default is still
# `cloud` (it flips to single-tenant in a later phase), and guessing either way
# here is a bad trade: guess cloud and a self-hoster's deploy tries to clone a
# private repository they cannot read; guess single-tenant and a Cloud deploy
# silently builds without its control plane. One clear question is cheaper than
# either failure.
EDITION="${BACKENLY_EDITION:-}"
if [ -z "$EDITION" ] && [ -f "$ROOT/.env" ]; then
  EDITION="$(grep -E '^[[:space:]]*BACKENLY_EDITION[[:space:]]*=' "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \t\r' || true)"
fi

if [ -z "$EDITION" ]; then
  cat >&2 <<'MSG'
compose-cloud: REFUSING - BACKENLY_EDITION is not set.

  This decides whether the build needs the private Cloud overlay, and it is not
  something to guess: defaulting to cloud makes a self-host deploy try to clone
  a repository it cannot read, and defaulting to single-tenant would let a Cloud
  deploy build with no control plane at all.

  Set it in the checkout's .env (or the deploy environment):

    BACKENLY_EDITION=cloud            for Backenly Cloud
    BACKENLY_EDITION=single-tenant    for a self-hosted install
MSG
  exit 1
fi

case "$EDITION" in
  cloud|single-tenant) ;;
  *) echo "compose-cloud: BACKENLY_EDITION must be \"cloud\" or \"single-tenant\", got \"$EDITION\"" >&2; exit 1 ;;
esac

echo "compose-cloud: edition      $EDITION"

# ---------------------------------------------------------------------------
# Single-tenant composes nothing, and must not reach for the private repo.
# ---------------------------------------------------------------------------
#
# A self-hosted install has no access to backenly-cloud and does not need any.
# Attempting the clone would fail their deploy on a repository that is none of
# their business.
if [ "$EDITION" = "single-tenant" ]; then
  echo "compose-cloud: single-tenant needs no private overlay, nothing to do"
  exit 0
fi

# ---------------------------------------------------------------------------
# Cloud: obtain the private repository.
# ---------------------------------------------------------------------------
CLOUD_REPO="${BACKENLY_CLOUD_REPO:-https://github.com/backenly/backenly-cloud.git}"
CLOUD_REF="${BACKENLY_CLOUD_REF:-main}"
CLOUD_DIR="${BACKENLY_CLOUD_DIR:-$(dirname "$ROOT")/backenly-cloud}"

echo "compose-cloud: private ref  $CLOUD_REF"
echo "compose-cloud: private dir  $CLOUD_DIR"

if [ -d "$CLOUD_DIR/.git" ]; then
  echo "compose-cloud: updating existing private checkout"
  if ! git -C "$CLOUD_DIR" fetch --quiet origin "$CLOUD_REF"; then
    echo "compose-cloud: ABORTING - could not fetch $CLOUD_REF from the private repository." >&2
    echo "compose-cloud: the build has NOT started and the live site is untouched." >&2
    exit 1
  fi
  git -C "$CLOUD_DIR" checkout --quiet FETCH_HEAD
else
  echo "compose-cloud: cloning the private repository"
  rm -rf "$CLOUD_DIR"
  if ! git clone --quiet --depth 1 --branch "$CLOUD_REF" "$CLOUD_REPO" "$CLOUD_DIR"; then
    cat >&2 <<'MSG'
compose-cloud: ABORTING - the private Cloud repository is unavailable.

  Cloud is the public repository plus the private overlay; without it this
  checkout is not Backenly Cloud. Building anyway would ship a process that
  refuses to start.

  Check that this host can read backenly/backenly-cloud (SSH deploy key or a
  git credential helper), then re-run. The build has NOT started.
MSG
    exit 1
  fi
fi

PRIVATE_SHA="$(git -C "$CLOUD_DIR" rev-parse HEAD)"
echo "compose-cloud: private sha  $PRIVATE_SHA"

# ---------------------------------------------------------------------------
# Are these two revisions meant to go together?
# ---------------------------------------------------------------------------
#
# The overlay is written against a specific public commit. Applying one written
# for a different revision is how a seam the private code expects turns out not
# to exist, and the symptom would appear later as a build or runtime error with
# nothing pointing back at the mismatch. This is a hard stop, not a warning,
# because a warning during an automated deploy is the same as nothing.
if [ ! -f "$CLOUD_DIR/PUBLIC_BASE_SHA" ]; then
  echo "compose-cloud: ABORTING - the private repository has no PUBLIC_BASE_SHA." >&2
  exit 1
fi

BASE_SHA="$(tr -d ' \t\r\n' < "$CLOUD_DIR/PUBLIC_BASE_SHA")"
PUBLIC_SHA="$(git -C "$ROOT" rev-parse HEAD)"

echo "compose-cloud: public sha   $PUBLIC_SHA"
echo "compose-cloud: pinned base  $BASE_SHA"

if [ "$BASE_SHA" != "$PUBLIC_SHA" ]; then
  cat >&2 <<MSG
compose-cloud: ABORTING - public and private revisions are not a matching pair.

  public checkout HEAD      $PUBLIC_SHA
  private PUBLIC_BASE_SHA   $BASE_SHA

  The overlay was written against a different public commit. Advance whichever
  side is behind and update PUBLIC_BASE_SHA in backenly-cloud, then re-run.
  The build has NOT started and the live site is untouched.
MSG
  exit 1
fi

# ---------------------------------------------------------------------------
# Apply. The boundary check lives in apply-overlay.sh, which refuses as a whole.
# ---------------------------------------------------------------------------
if [ "$CHECK_ONLY" = "1" ]; then
  bash "$ROOT/scripts/apply-overlay.sh" "$CLOUD_DIR" --dry-run
  echo "compose-cloud: check only, nothing applied"
  exit 0
fi

if ! bash "$ROOT/scripts/apply-overlay.sh" "$CLOUD_DIR"; then
  echo "compose-cloud: ABORTING - the overlay could not be applied. Nothing was copied." >&2
  echo "compose-cloud: the build has NOT started and the live site is untouched." >&2
  exit 1
fi

echo "compose-cloud: OK - composed for cloud"
