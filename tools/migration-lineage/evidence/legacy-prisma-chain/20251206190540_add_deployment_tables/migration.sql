/*
  Warnings:

  - A unique constraint covering the columns `[name,projectId]` on the table `roles` will be added. If there are existing duplicate values, this will fail.
  - Made the column `projectId` on table `anomalies` required. This step will fail if there are existing NULL values in that column.
  - Made the column `projectId` on table `blocked_attacks` required. This step will fail if there are existing NULL values in that column.
  - Made the column `projectId` on table `database_issues` required. This step will fail if there are existing NULL values in that column.
  - Made the column `projectId` on table `incidents` required. This step will fail if there are existing NULL values in that column.
  - Made the column `projectId` on table `metrics` required. This step will fail if there are existing NULL values in that column.
  - Made the column `projectId` on table `security_issues` required. This step will fail if there are existing NULL values in that column.
  - Made the column `projectId` on table `security_scans` required. This step will fail if there are existing NULL values in that column.
  - Made the column `projectId` on table `storage_buckets` required. This step will fail if there are existing NULL values in that column.
  - Made the column `projectId` on table `storage_files` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "roles_name_key";

-- AlterTable
ALTER TABLE "anomalies" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "capabilities" TEXT[],
ADD COLUMN     "keyType" TEXT NOT NULL DEFAULT 'public',
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "serviceRole" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "role" SET DEFAULT 'client';

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "blocked_attacks" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "database_issues" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "incidents" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "metrics" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "security_issues" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "security_scans" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "storage_buckets" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "storage_files" ALTER COLUMN "projectId" SET NOT NULL;

-- CreateTable
CREATE TABLE "ai_configurations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'gpt-4',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "maxTokens" INTEGER NOT NULL DEFAULT 2000,
    "systemPrompt" TEXT,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION,
    "endpoint" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'preview',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "url" TEXT,
    "buildId" TEXT,
    "commitSha" TEXT,
    "branch" TEXT DEFAULT 'main',
    "config" JSONB,
    "manifest" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "errorMessage" TEXT,
    "errorStack" TEXT,
    "promotedFrom" TEXT,
    "rolledBackTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "providerCredentialId" TEXT,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_logs" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "deployment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credentials" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT,
    "credentials" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_configurations_projectId_key" ON "ai_configurations"("projectId");

-- CreateIndex
CREATE INDEX "ai_configurations_projectId_idx" ON "ai_configurations"("projectId");

-- CreateIndex
CREATE INDEX "ai_usage_projectId_idx" ON "ai_usage"("projectId");

-- CreateIndex
CREATE INDEX "ai_usage_createdAt_idx" ON "ai_usage"("createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_model_idx" ON "ai_usage"("model");

-- CreateIndex
CREATE INDEX "deployments_projectId_idx" ON "deployments"("projectId");

-- CreateIndex
CREATE INDEX "deployments_status_idx" ON "deployments"("status");

-- CreateIndex
CREATE INDEX "deployments_provider_idx" ON "deployments"("provider");

-- CreateIndex
CREATE INDEX "deployments_environment_idx" ON "deployments"("environment");

-- CreateIndex
CREATE INDEX "deployments_createdAt_idx" ON "deployments"("createdAt");

-- CreateIndex
CREATE INDEX "deployment_logs_deploymentId_idx" ON "deployment_logs"("deploymentId");

-- CreateIndex
CREATE INDEX "deployment_logs_timestamp_idx" ON "deployment_logs"("timestamp");

-- CreateIndex
CREATE INDEX "provider_credentials_projectId_idx" ON "provider_credentials"("projectId");

-- CreateIndex
CREATE INDEX "provider_credentials_provider_idx" ON "provider_credentials"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credentials_projectId_provider_key" ON "provider_credentials"("projectId", "provider");

-- CreateIndex
CREATE INDEX "api_keys_projectId_idx" ON "api_keys"("projectId");

-- CreateIndex
CREATE INDEX "api_keys_keyType_idx" ON "api_keys"("keyType");

-- CreateIndex
CREATE INDEX "audit_logs_projectId_idx" ON "audit_logs"("projectId");

-- CreateIndex
CREATE INDEX "roles_projectId_idx" ON "roles"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_projectId_key" ON "roles"("name", "projectId");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_configurations" ADD CONSTRAINT "ai_configurations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_providerCredentialId_fkey" FOREIGN KEY ("providerCredentialId") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
