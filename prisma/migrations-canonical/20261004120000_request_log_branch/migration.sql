-- A request log row records which preview branch, if any, served it.
--
-- A key bound to a preview branch is served from the branch by the data plane,
-- but its requests were logged exactly like production traffic. Every
-- production health signal reads this table (Monitoring, the autonomy change
-- freeze, the auth-spike and 5xx detectors), so an agent running failure tests
-- against a preview would have looked like a production incident.
--
-- Additive only. The column is nullable and existing rows stay NULL, which is
-- what they are: main traffic. Nothing is backfilled, renamed or dropped, so
-- the application that predates this migration keeps reading and writing the
-- table unchanged, and the migration survives a rollback of the release that
-- uses it.
--
-- The index is built without CONCURRENTLY because migrations run in a
-- transaction. Inserts into this table come only from the request recorder,
-- which buffers rows and flushes them in the background (lib/traffic/
-- request-recorder.ts), so a brief lock delays a flush and never a request.

-- AlterTable
ALTER TABLE "api_request_logs" ADD COLUMN     "branchId" TEXT;

-- CreateIndex
CREATE INDEX "api_request_logs_branchId_timestamp_idx" ON "api_request_logs"("branchId", "timestamp");
