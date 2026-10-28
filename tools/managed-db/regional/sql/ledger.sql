-- ============================================================================
-- The bootstrap ledger: what this procedure applied here, and when.
-- ============================================================================
-- bootstrap_steps        one row per step, with the checksum of the files it
--                        applied, so a re-run (or BOOTSTRAP_MODE=check) can say
--                        which steps are current and which have changed since.
-- bootstrap_credentials  one row per login role whose password this procedure
--                        set. PostgreSQL records a password only in pg_authid,
--                        which the RDS master cannot read, so without this a
--                        re-run could not tell a first install from a live one
--                        (scripts/setup-postgrest-roles.ts has the history of
--                        guessing). roles.sql reads it to refuse any run that
--                        would replace a live credential without being asked.
--
-- Readable by the administrator only: the application never needs it.

CREATE SCHEMA IF NOT EXISTS backenly_meta;
REVOKE ALL ON SCHEMA backenly_meta FROM PUBLIC;

CREATE TABLE IF NOT EXISTS backenly_meta.bootstrap_steps (
  step       text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL,
  applied_by text NOT NULL
);
REVOKE ALL ON backenly_meta.bootstrap_steps FROM PUBLIC;

CREATE TABLE IF NOT EXISTS backenly_meta.bootstrap_credentials (
  role_name  text PRIMARY KEY,
  set_at     timestamptz NOT NULL,
  set_by     text NOT NULL,
  rotations  integer NOT NULL DEFAULT 0
);
REVOKE ALL ON backenly_meta.bootstrap_credentials FROM PUBLIC;
