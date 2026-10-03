/*
  Warnings:

  - A unique constraint covering the columns `[subdomain]` on the table `projects` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[customDomain]` on the table `projects` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "customDomain" TEXT,
ADD COLUMN     "domainVerificationToken" TEXT,
ADD COLUMN     "domainVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subdomain" TEXT,
ADD COLUMN     "workerContainerId" TEXT,
ADD COLUMN     "workerPort" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "projects_subdomain_key" ON "projects"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "projects_customDomain_key" ON "projects"("customDomain");
