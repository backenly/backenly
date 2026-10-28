-- The Backenly Cloud region holding a project's data (lib/regions.ts).
--
-- NULL is the home region, ap-south-1: every project that exists today and
-- every self-hosted project. lib/data-plane/regional.ts opens every connection
-- to a project's data in the region recorded here and never falls back to
-- another, because the project's schema exists only in that region.
--
-- Additive: one nullable column with no default, no existing row or column
-- touched, so the release that predates this migration runs unchanged against
-- it. Nothing writes the column until a second region opens.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "region" TEXT;
