-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "databaseProvisioned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "databaseProvisionedAt" TIMESTAMP(3),
ADD COLUMN     "mongodbDatabase" TEXT,
ADD COLUMN     "postgresSchema" TEXT;
