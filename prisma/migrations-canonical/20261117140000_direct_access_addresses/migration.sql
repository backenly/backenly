-- The addresses a project's direct Postgres logins may connect from
-- (lib/services/direct-access-addresses.ts). Where a region's database has a
-- public endpoint, its network allowlist admits the union of every project's
-- addresses in that region and nothing else (lib/services/direct-access-allowlist.ts).
--
-- Additive: one new table, its unique index and its foreign key to projects
-- (rows go with their project). Nothing existing is changed, so the release
-- that predates this migration runs unchanged against it.

-- CreateTable
CREATE TABLE "direct_access_addresses" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "direct_access_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "direct_access_addresses_projectId_cidr_key" ON "direct_access_addresses"("projectId", "cidr");

-- AddForeignKey
ALTER TABLE "direct_access_addresses" ADD CONSTRAINT "direct_access_addresses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
