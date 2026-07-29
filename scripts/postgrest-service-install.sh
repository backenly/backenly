#!/usr/bin/env bash
#
# Put the PostgREST data plane under process supervision.
#
# ── The outage this exists to make impossible ───────────────────────────────
#
# On 2026-07-29 every project's `/db/*` endpoint was returning
#
#   502  {"error":"Data plane unavailable","code":"UPSTREAM_UNAVAILABLE"}
#
# because PostgREST was not running. Not crashed into a bad state — simply not
# running, with nothing listening on :3002 at all. There was no systemd unit and
# no pm2 entry for it: the process had been started by hand, it died, and
# nothing in the system had any opinion about that.
#
# Everything else stayed green. `/healthz` answers from Prisma and never touches
# PostgREST. `/auth/*` and `/fn/*` run on the Express runtime. The platform's own
# contract probe was the only thing that noticed, and all it could do was file a
# finding, because a schema repair cannot restart a process.
#
# Supervision is the actual fix. The autonomy loop's HEAL_DATA_PLANE
# (lib/postgrest/supervisor.ts) is the second line — it handles the case
# supervision cannot, a process that is alive but wedged (PGRST002), which
# `Restart=always` will never notice because nothing exits.
#
# Idempotent. Safe to re-run on every deploy, and re-running is the intended way
# to pick up changes to the unit.
#
#   sudo bash scripts/postgrest-service-install.sh
#
set -euo pipefail

CONF="${POSTGREST_CONF:-/etc/postgrest/postgrest.conf}"
BIN="${POSTGREST_BIN:-/usr/local/bin/postgrest}"
UNIT=/etc/systemd/system/postgrest.service
SVC_USER=postgrest

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run as root (it writes a systemd unit)." >&2
  exit 1
fi

for path in "$BIN" "$CONF"; do
  if [ ! -e "$path" ]; then
    echo "Missing: $path" >&2
    echo "Install PostgREST and its config first, then re-run." >&2
    exit 1
  fi
done

# A loopback daemon holding database credentials has no reason to run as root.
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  echo "  → creating system user '$SVC_USER'"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

# The config carries the db-uri password and the JWT secret.
chown "$SVC_USER:$SVC_USER" "$CONF"
chmod 600 "$CONF"

echo "  → writing $UNIT"
cat > "$UNIT" <<EOF
[Unit]
Description=PostgREST data plane for Backenly
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
ExecStart=$BIN $CONF
ExecReload=/bin/kill -HUP \$MAINPID

# The whole point of this unit. PostgREST was started by hand, died, and nothing
# brought it back, so every project served 502 on /db/* until a human noticed.
Restart=always
RestartSec=5

# StartLimit is disabled DELIBERATELY. systemd's default — 5 starts in 10s, then
# give up permanently — converts a transient crash-loop into exactly the
# permanent outage this unit exists to prevent. Retrying forever is correct here:
# the failure mode of trying too often is log noise; the failure mode of giving
# up is every tenant's data plane staying dead.
StartLimitIntervalSec=0

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now postgrest

# Assert, never announce. A "started" line printed without checking is how a
# broken install looks identical to a working one.
echo "  → waiting for :3002"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:3002/ 2>/dev/null; then
    ok=1
    break
  fi
  sleep 1
done

echo
echo "  enabled at boot : $(systemctl is-enabled postgrest)"
echo "  running now     : $(systemctl is-active postgrest)"

if [ "${ok:-0}" != "1" ]; then
  echo
  echo "  PostgREST is NOT answering on 127.0.0.1:3002." >&2
  echo "  journalctl -u postgrest -n 50 --no-pager" >&2
  exit 1
fi

echo "  answering on    : 127.0.0.1:3002"
echo
echo "Next — give the autonomy loop its restart channel so it can repair a"
echo "wedged schema cache (PGRST002), which Restart=always cannot see because"
echo "the process never exits:"
echo
echo "  POSTGREST_RESTART_COMMAND=\"systemctl restart postgrest\"   # in the app env"
echo
