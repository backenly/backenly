-- A request log row records the browser origin it came from.
--
-- Connection Health (the sidebar's Frontend row, Deploy, Connect) said a
-- frontend was connected only when the SDK's bootstrap ping had been seen, so
-- an app calling the API from its own origin with its key read as "Not
-- connected" (production QA, 2026-11-09). With the origin on each row, the
-- frontend's actual requests are counted.
--
-- The origin is scheme, host and port only, never a path or a query, and null
-- for a server or a tool (lib/traffic/request-recorder.ts).
--
-- Additive only. The column is nullable and existing rows stay NULL; nothing
-- is backfilled, renamed or dropped, so the application that predates this
-- migration keeps reading and writing the table unchanged. Adding a nullable
-- column without a default rewrites no rows. No index: Connection Health reads
-- one project's last day through ("projectId", "timestamp").

-- AlterTable
ALTER TABLE "api_request_logs" ADD COLUMN     "origin" TEXT;
