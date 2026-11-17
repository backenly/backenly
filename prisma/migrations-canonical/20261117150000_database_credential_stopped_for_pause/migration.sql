-- When a pause or a deletion stopped a direct Postgres login
-- (lib/projects/paused-logins.ts). Resuming or restoring the project brings
-- back only a login that carries it, so a login stopped for any other reason
-- (a revocation that has not finished, an operator's own hand) stays stopped.
--
-- Additive: one nullable column with no default, so no row is rewritten and
-- the release that predates this migration runs unchanged against it. Every
-- existing login stays NULL. It depends on no other migration.

-- AlterTable
ALTER TABLE "database_credentials" ADD COLUMN "stoppedForPauseAt" TIMESTAMP(3);
