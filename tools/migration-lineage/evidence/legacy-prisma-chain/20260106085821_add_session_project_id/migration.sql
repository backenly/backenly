/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `projects` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "healthCheckError" TEXT,
ADD COLUMN     "healthCheckStatus" TEXT,
ADD COLUMN     "healthCheckUrl" TEXT,
ALTER COLUMN "status" SET DEFAULT 'queued';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "maxFileSize" BIGINT NOT NULL DEFAULT 10485760,
ADD COLUMN     "maxFilesPerBucket" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "publicEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "storageLimit" BIGINT NOT NULL DEFAULT 1073741824;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "storage_buckets" ADD COLUMN     "allowedExtensions" TEXT[] DEFAULT ARRAY['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.txt', '.csv']::TEXT[],
ADD COLUMN     "allowedMimeTypes" TEXT[] DEFAULT ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv']::TEXT[],
ADD COLUMN     "blockExecutables" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxFileSizeBytes" BIGINT NOT NULL DEFAULT 10485760,
ADD COLUMN     "overwriteStrategy" TEXT NOT NULL DEFAULT 'auto_rename';

-- AlterTable
ALTER TABLE "storage_files" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "originalName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "deployTarget" TEXT NOT NULL DEFAULT 'node',
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'typescript',
ADD COLUMN     "runtime" TEXT NOT NULL DEFAULT 'express',
ADD COLUMN     "runtimeLocked" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "workspace_files" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "description" TEXT,
    "language" TEXT NOT NULL DEFAULT 'typescript',
    "category" TEXT NOT NULL DEFAULT 'code',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT,

    CONSTRAINT "workspace_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "warning" TEXT,
    "codeGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_oauth_configs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "redirectUri" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "generatedAt" TIMESTAMP(3),
    "configuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsed" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_oauth_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_shares" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL DEFAULT 'read_only',
    "allowAuth" BOOLEAN NOT NULL DEFAULT false,
    "allowWrites" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "label" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preview_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_cors_origins" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_cors_origins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_files_projectId_idx" ON "workspace_files"("projectId");

-- CreateIndex
CREATE INDEX "workspace_files_category_idx" ON "workspace_files"("category");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_files_projectId_path_key" ON "workspace_files"("projectId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "auth_policies_name_key" ON "auth_policies"("name");

-- CreateIndex
CREATE INDEX "workspace_oauth_configs_projectId_idx" ON "workspace_oauth_configs"("projectId");

-- CreateIndex
CREATE INDEX "workspace_oauth_configs_provider_idx" ON "workspace_oauth_configs"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_oauth_configs_projectId_provider_key" ON "workspace_oauth_configs"("projectId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "preview_shares_token_key" ON "preview_shares"("token");

-- CreateIndex
CREATE INDEX "preview_shares_projectId_idx" ON "preview_shares"("projectId");

-- CreateIndex
CREATE INDEX "preview_shares_userId_idx" ON "preview_shares"("userId");

-- CreateIndex
CREATE INDEX "preview_shares_token_idx" ON "preview_shares"("token");

-- CreateIndex
CREATE INDEX "preview_shares_expiresAt_idx" ON "preview_shares"("expiresAt");

-- CreateIndex
CREATE INDEX "preview_shares_revoked_idx" ON "preview_shares"("revoked");

-- CreateIndex
CREATE INDEX "project_cors_origins_projectId_idx" ON "project_cors_origins"("projectId");

-- CreateIndex
CREATE INDEX "project_cors_origins_origin_idx" ON "project_cors_origins"("origin");

-- CreateIndex
CREATE UNIQUE INDEX "project_cors_origins_projectId_origin_key" ON "project_cors_origins"("projectId", "origin");

-- CreateIndex
CREATE INDEX "database_issues_projectId_status_idx" ON "database_issues"("projectId", "status");

-- CreateIndex
CREATE INDEX "database_issues_projectId_severity_idx" ON "database_issues"("projectId", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "projects_userId_idx" ON "projects"("userId");

-- CreateIndex
CREATE INDEX "projects_updatedAt_idx" ON "projects"("updatedAt");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_projectId_idx" ON "sessions"("projectId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "storage_files_deletedAt_idx" ON "storage_files"("deletedAt");

-- CreateIndex
CREATE INDEX "workspaces_projectId_idx" ON "workspaces"("projectId");

-- CreateIndex
CREATE INDEX "workspaces_userId_idx" ON "workspaces"("userId");

-- CreateIndex
CREATE INDEX "workspaces_runtime_idx" ON "workspaces"("runtime");

-- AddForeignKey
ALTER TABLE "workspace_files" ADD CONSTRAINT "workspace_files_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_oauth_configs" ADD CONSTRAINT "workspace_oauth_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_cors_origins" ADD CONSTRAINT "project_cors_origins_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
