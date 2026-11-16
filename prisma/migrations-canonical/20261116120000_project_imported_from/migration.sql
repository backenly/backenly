-- Where a project was moved in from (Cloud: "Bring your backend",
-- lib/import/jobs.ts): the source's kind, when, and counts of what arrived
-- (tables, rows, users, files, access rules still waiting for approval). The
-- Projects page shows "Moved in from Supabase on Nov 12". Never a name, a
-- definition or a value of the source's.
--
-- Additive only: one nullable column with no default, so no row is rewritten
-- and the release that predates this migration runs unchanged against it.
-- Every existing project stays NULL (created from scratch); only an import
-- writes it, once, when it finishes.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "importedFrom" JSONB;
