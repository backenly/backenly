-- A webhook endpoint can name the tables it receives row events for.
--
-- An endpoint subscribed to a row event received it for every table in the
-- project, so one listening for new orders also got every analytics insert
-- (production QA, 2026-11-09: 1.14M rows on one table). The list is optional:
-- empty, the default, keeps today's every-table behaviour. Sign-up events
-- (auth.user.created) do not come from a table and ignore it.
--
-- Additive only. Existing rows take the empty default, which is exactly what
-- they receive today; nothing is renamed or dropped, so the application that
-- predates this migration keeps reading and writing the table unchanged. No
-- index: delivery reads one project's active endpoints for one event type.

-- AlterTable
ALTER TABLE "webhooks" ADD COLUMN     "tables" TEXT[] DEFAULT ARRAY[]::TEXT[];
