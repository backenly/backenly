-- Which database holds a project's data (lib/data-plane/regional.ts
-- projectDatabase). "databaseTenancy" is 'shared' for a project whose
-- workspace schema is in its region's own database, as every project's is
-- today, or 'dedicated' for a project with a database of its own:
-- "databaseName" (p_ followed by 32 lowercase hex digits) on the region's data
-- instance "databaseInstance" (null is the region's primary one).
-- "tenancyEpoch" moves each time the project's data moves to another database.
--
-- Additive: two nullable columns, two columns with constant defaults (no row is
-- rewritten on PostgreSQL 11 and later) and one unique index over a column that
-- is NULL on every existing row. Every existing project reads 'shared' at epoch
-- 0, which is where its data is, so the release that predates this migration
-- runs unchanged against it.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "databaseInstance" TEXT,
ADD COLUMN     "databaseName" TEXT,
ADD COLUMN     "databaseTenancy" TEXT NOT NULL DEFAULT 'shared',
ADD COLUMN     "tenancyEpoch" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "projects_databaseName_key" ON "projects"("databaseName");
