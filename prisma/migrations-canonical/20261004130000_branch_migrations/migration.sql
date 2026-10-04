-- Preview branches record the schema changes made on them, and production can
-- be protected so an agent changes it only through a reviewed merge.
--
--   workspace_branch_migrations  one row per migration applied to a branch, in
--                                order. A merge replays these statements onto
--                                main through apply_migration's governed path.
--   workspace_branches.baseSnapshot
--                                main's schema when the branch was cut, so a
--                                merge can tell a branch change from one made
--                                on main since.
--   projects.protectedProduction an agent may change this project's schema only
--                                on a branch. Defaults to false, so every
--                                existing project behaves exactly as before.
--
-- The two unique indexes on workspace_branches are replaced with plain ones.
-- Names only need to be unique among ACTIVE branches (enforced in
-- lib/branches/engine.ts): a merged or discarded branch keeps its row as
-- history while its schema is dropped, and the database-wide uniques made
-- re-creating a branch of the same name fail after its schema had already
-- been created and registered.
--
-- Additive otherwise. The application that predates this migration never reads
-- the new column or table and already checks active names itself, so the
-- migration can run before the release that uses it and survives a rollback.

-- DropIndex
DROP INDEX "workspace_branches_schemaName_key";

-- DropIndex
DROP INDEX "workspace_branches_projectId_name_key";

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "protectedProduction" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "workspace_branches" ADD COLUMN     "baseSnapshot" JSONB;

-- CreateTable
CREATE TABLE "workspace_branch_migrations" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "statements" JSONB NOT NULL,
    "appliedBy" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_branch_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_branch_migrations_branchId_seq_key" ON "workspace_branch_migrations"("branchId", "seq");

-- CreateIndex
CREATE INDEX "workspace_branches_projectId_name_idx" ON "workspace_branches"("projectId", "name");

-- CreateIndex
CREATE INDEX "workspace_branches_schemaName_idx" ON "workspace_branches"("schemaName");

-- AddForeignKey
ALTER TABLE "workspace_branch_migrations" ADD CONSTRAINT "workspace_branch_migrations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "workspace_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
