-- When a project asked to be deleted is removed for good
-- (lib/projects/deletion.ts). Deleting a project sets "deletedAt", which every
-- listing, count and background pass already skips, and "purgeAfter" seven days
-- later; the daily purge removes projects past it, and restoring before then
-- clears both.
--
-- Additive: one nullable column with no default and its index, so no row is
-- rewritten and the release that predates this migration runs unchanged
-- against it. Every existing project stays NULL.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "purgeAfter" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "projects_purgeAfter_idx" ON "projects"("purgeAfter");
