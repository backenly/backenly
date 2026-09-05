#!/usr/bin/env bash
# ============================================================================
# A CLONE UNDER A 0750 HOME MUST STILL INSTALL ITS SQL
# ============================================================================
# Reproduces the acceptance failure that stopped a clean Ubuntu 24.04 install:
#
#   psql: error: /home/ubuntu/backenly/scripts/sql/postgrest-schema-registry.sql:
#         Permission denied
#
# Ubuntu creates home directories 0750 (HOME_MODE in /etc/login.defs), so the
# `postgres` OS user cannot traverse /home/<user>. `psql -f <path>` makes the
# DATABASE's user open the file, so a normal clone in the operator's home was
# unreadable — while the file itself was world-readable, which is what made the
# failure so confusing.
#
# The fix is that the operator's shell opens the file and psql reads stdin. This
# proves it, and proves the old form still fails, by running the real script as
# one user while psql runs as another.
#
# psql is stubbed. The property under test is WHO OPENS THE FILE, which is
# decided by the shell, not by PostgreSQL — a real server would add minutes and
# test nothing extra.
#
# Linux only: it needs two users and POSIX permissions.
#
#   bash scripts/test/sql-file-access.sh
#
set -euo pipefail

# A skip is a green tick that proves nothing, so CI sets REQUIRE=1 and turns
# every skip into a failure. Developers on macOS or Windows still get a skip;
# the job that is supposed to guarantee this cannot quietly become one.
REQUIRE="${SQL_FILE_ACCESS_REQUIRE:-0}"
bail() {
  if [ "$REQUIRE" = "1" ]; then echo "FAIL (SQL_FILE_ACCESS_REQUIRE=1): $1"; exit 1; fi
  echo "SKIP: $1"; exit 0
}

[ "$(uname -s)" = "Linux" ] || bail "needs Linux (two users + POSIX permissions); this is $(uname -s)"
sudo -n true 2>/dev/null || bail "needs passwordless sudo to run psql as another user"
command -v python3 >/dev/null 2>&1 || bail "needs python3 for the mutation step"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
DBUSER="bkn_sqlprobe"
STUB="/usr/local/bin/psql"
FAILURES=0

cleanup() {
  sudo rm -f "$STUB" 2>/dev/null || true
  sudo userdel "$DBUSER" 2>/dev/null || true
  chmod -R u+rwx "$WORK" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ok()   { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }

# ── A second user, standing in for `postgres` ───────────────────────────────
sudo useradd -M -s /usr/sbin/nologin "$DBUSER" 2>/dev/null || true

# ── A psql that is honest about -f ──────────────────────────────────────────
# Opens the named file, or reads stdin for `-f -`. That single behaviour is the
# whole difference between the two forms.
sudo tee "$STUB" >/dev/null <<'STUBEOF'
#!/usr/bin/env bash
file=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-f" ]; then file="$a"; fi
  prev="$a"
done
if [ -n "$file" ] && [ "$file" != "-" ]; then
  cat -- "$file" >/dev/null || exit 1
else
  cat >/dev/null || exit 1
fi
exit 0
STUBEOF
sudo chmod 0755 "$STUB"

# ── A repo checkout under a 0750 parent, exactly like a home directory ──────
HOMEISH="$WORK/home"
mkdir -p "$HOMEISH"
chmod 0750 "$HOMEISH"
CLONE="$HOMEISH/backenly"
mkdir -p "$CLONE/scripts/lib" "$CLONE/scripts/sql"
cp "$REPO/scripts/lib/db-admin.sh" "$CLONE/scripts/lib/db-admin.sh"
cp "$REPO/scripts/install-sql.sh"  "$CLONE/scripts/install-sql.sh"
printf 'SELECT 1;\n' > "$CLONE/scripts/sql/probe.sql"
chmod 0644 "$CLONE/scripts/sql/probe.sql"

# ── The trap is real ────────────────────────────────────────────────────────
# If the other user CAN read the file, the rest of this proves nothing, so this
# guard must come first.
if sudo -u "$DBUSER" cat "$CLONE/scripts/sql/probe.sql" >/dev/null 2>&1; then
  fail "precondition: $DBUSER can read the file, so 0750 is not in effect here"
else
  ok "precondition: $DBUSER cannot read a file under the 0750 parent"
fi

run_install() {
  # `local` mode, with the stand-in user substituted for postgres. Runs as the
  # invoking user, which is the operator, exactly as documented.
  sed "s/sudo -u postgres psql/sudo -u $DBUSER psql/" \
    "$CLONE/scripts/lib/db-admin.sh" > "$CLONE/scripts/lib/db-admin.sh.tmp"
  mv "$CLONE/scripts/lib/db-admin.sh.tmp" "$CLONE/scripts/lib/db-admin.sh"
  BACKENLY_DB_ADMIN=local bash "$CLONE/scripts/install-sql.sh" "$CLONE/scripts/sql/probe.sql" 2>&1
}

# ── The current implementation must succeed ─────────────────────────────────
if OUT="$(run_install)"; then
  ok "install-sql.sh installs a file under a 0750 parent"
else
  fail "install-sql.sh FAILED under a 0750 parent:"
  echo "$OUT" | sed 's/^/        /'
fi

# ── Reverting to -f "$file" must fail ───────────────────────────────────────
# The mutation test. Without it, the check above could pass for a reason that
# has nothing to do with the redirect.
cp "$REPO/scripts/lib/db-admin.sh" "$CLONE/scripts/lib/db-admin.sh"
python3 - "$CLONE/scripts/lib/db-admin.sh" <<'PYEOF'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = 'db_admin_psql -v ON_ERROR_STOP=1 -q -f - < "$file"'
assert s.count(old) == 1, 'mutation target not found in db-admin.sh'
io.open(p, 'w', encoding='utf-8', newline='').write(
    s.replace(old, 'db_admin_psql -v ON_ERROR_STOP=1 -q -f "$file"'))
PYEOF

if OUT="$(run_install)"; then
  fail "reverting to -f \"\$file\" still succeeded, so this test proves nothing"
else
  if echo "$OUT" | grep -qi "permission denied\|No such file"; then
    ok "reverting to -f \"\$file\" fails, the way it did on the acceptance machine"
  else
    ok "reverting to -f \"\$file\" fails (different message, still a failure)"
  fi
fi

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES check(s) failed."
  exit 1
fi
echo "sql file access: all checks passed."
