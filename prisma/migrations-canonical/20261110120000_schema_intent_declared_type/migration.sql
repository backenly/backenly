-- The intent ledger keeps the type a statement declared, exactly.
--
-- A column declared `timestamptz` in a migration was recorded as the typed
-- tools' word "timestamp" and compared by kind, so becoming `timestamp without
-- time zone` (which drops every offset written to it) was never reported. The
-- declared type is now kept beside the word and compared with the type
-- PostgreSQL reports.
--
-- Purely additive: one nullable column. Rows recorded before it keep NULL and
-- are compared by kind, as before.

-- AlterTable
ALTER TABLE "schema_intents" ADD COLUMN "requestedSqlType" TEXT;
