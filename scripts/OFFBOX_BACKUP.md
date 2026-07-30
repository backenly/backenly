# Off-box backups

`scripts/backup.sh` writes nightly dumps to `/var/backups/backenly` on the
application server. That protects against a bad migration or an accidental
`DROP`. It does **not** protect against losing the disk, and until an off-box
copy exists every backup and the database it protects live on the same device.

This file was referenced from `backup.sh` and from its own warning message for
some time before it existed. It exists now.

## What is configured today

| | |
|---|---|
| Local dumps | `/var/backups/backenly/backenly-<DATE>.dump` (custom format, `pg_dump -Fc`) |
| Globals | `/var/backups/backenly/globals-<DATE>.sql` (`pg_dumpall --globals-only` — roles and grants) |
| Off-box remote | rclone remote `b2:` → bucket `backenly-backups` |
| Retention | `BACKUP_KEEP_DAYS` (default 7), mirrored off-box |
| Schedule | root crontab, `0 2 * * *` |
| Restore check | root crontab, `30 3 * * 0` → `scripts/verify-backup-restore.sh` |

Both dump files are pushed; restoring needs **both**, because the custom-format
dump does not contain role definitions. Restoring without `globals-*.sql` gives
you the data with every `GRANT` and `ALTER ROLE` missing, which on this database
means RLS policies that reference roles that no longer exist.

## Enabling it

```bash
rclone config          # once, to create the remote (e.g. Backblaze B2)
rclone lsd b2:         # verify the remote answers and the bucket is visible
```

Then set the target in the application `.env` (gitignored):

```
BACKUP_REMOTE="b2:backenly-backups"
```

`backup.sh` reads `BACKUP_*` keys from `.env` itself — it deliberately does not
source the whole file — so cron's bare environment is not a problem.

## The failure this had, and what to check first

Off-box pushes ran until 2026-07-23 and then silently stopped for seven days.
`BACKUP_REMOTE` was correctly set in `.env` the whole time. The script defaulted
`ENV_FILE` to `/opt/backenly/.env`, a path that does not exist on this host — the
checkout is `/var/www/backenly/backenly` — so the `[ -f "$ENV_FILE" ]` guard was
false, no `BACKUP_*` key was ever exported, and the off-box branch was skipped.

The log line said:

```
WARNING: BACKUP_REMOTE not set (or rclone missing) — backup is ON-DISK ONLY.
```

which reads like a deliberate configuration choice rather than a broken path, so
nothing about it invited investigation. `ENV_FILE` is now derived from the
script's own location, and the warning names the specific cause.

**If off-box copies stop again, check in this order:**

1. `rclone lsl b2:backenly-backups | sort -k2 | tail -3` — how recent is the
   newest object? That dates the failure.
2. `grep -c '^BACKUP_REMOTE=' /var/www/backenly/backenly/.env` — is it set?
3. `bash scripts/backup.sh` by hand and read the warning — it now distinguishes
   "no `.env` at that path", "no `BACKUP_REMOTE=` line", and "rclone missing".
4. `command -v rclone` **as root under cron's PATH**, not just in your shell.

## Verifying a restore

Local dumps being present is not evidence they restore.
`scripts/verify-backup-restore.sh` runs weekly and restores the newest dump into
a scratch database. Run it manually after any change to this pipeline:

```bash
bash scripts/verify-backup-restore.sh
```

## Still open

The bucket holds the platform database. It does **not** hold the per-project
workspace backups written by `runDailyBackups` into `./backups/` — those are
covered by the whole-database dump, since workspace schemas live in the same
database, but they are not separately versioned off-box.
