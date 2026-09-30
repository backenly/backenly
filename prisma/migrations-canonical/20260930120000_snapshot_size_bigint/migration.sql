-- A database snapshot's recorded size becomes a 64-bit integer.
--
-- workspace_backups."sizeBytes" was INTEGER, whose largest value is 2 GiB - 1.
-- A compressed snapshot is about a quarter of the database it dumps, so a
-- project near Pro's included 8 GB produced a snapshot whose size could not be
-- recorded: the row write failed and the snapshot was lost.
--
-- Widening only. Every existing value is kept exactly (all fit in INTEGER), no
-- row is backfilled, and nothing is dropped or renamed. The application that
-- predates this migration still reads and writes the column (its values stay
-- in INTEGER range), so the migration can run before the release that uses it
-- and survives a rollback of that release. The table holds one row per project
-- per day for seven days, so the rewrite is brief.

-- AlterTable
ALTER TABLE "workspace_backups" ALTER COLUMN "sizeBytes" SET DATA TYPE BIGINT;
