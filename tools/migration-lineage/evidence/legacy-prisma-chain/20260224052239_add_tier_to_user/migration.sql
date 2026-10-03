/*
  Warnings:

  - You are about to drop the `deployment_logs` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `deployments` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `project_cors_origins` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PRIVATE', 'DEPLOYING', 'LIVE', 'FAILED');

-- DropForeignKey
ALTER TABLE "deployment_logs" DROP CONSTRAINT "deployment_logs_deploymentId_fkey";

-- DropForeignKey
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_projectId_fkey";

-- DropForeignKey
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_providerCredentialId_fkey";

-- DropForeignKey
ALTER TABLE "project_cors_origins" DROP CONSTRAINT "project_cors_origins_projectId_fkey";

-- AlterTable
ALTER TABLE "project_metadata" ADD COLUMN     "backendStateGraph" JSONB;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "activeGraphId" TEXT,
ADD COLUMN     "architecturalMemory" TEXT,
ADD COLUMN     "deployedAt" TIMESTAMP(3),
ADD COLUMN     "deploymentError" TEXT,
ADD COLUMN     "projectStatus" "ProjectStatus" NOT NULL DEFAULT 'PRIVATE',
ADD COLUMN     "publicUrl" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tier" TEXT NOT NULL DEFAULT 'free';

-- DropTable
DROP TABLE "deployment_logs";

-- DropTable
DROP TABLE "deployments";

-- DropTable
DROP TABLE "project_cors_origins";

-- CreateTable
CREATE TABLE "delegated_connections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "metadata" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "delegated_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delegation_audit_logs" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "endpoint" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delegation_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intent_logs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "canonicalIntent" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "changes" JSONB,
    "rollbackData" JSONB,
    "rollbackExecutionId" TEXT,
    "rolledBack" BOOLEAN NOT NULL DEFAULT false,
    "rolledBackAt" TIMESTAMP(3),
    "liveMutation" BOOLEAN NOT NULL DEFAULT false,
    "liveMutationStatus" TEXT,

    CONSTRAINT "intent_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backend_graphs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "graphData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "intentId" TEXT,
    "sequenceNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "backend_graphs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_suggestions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "graphId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "suggestedPrompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'preview',
    "status" TEXT NOT NULL DEFAULT 'queued',
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

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentLog" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentAudit" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "triggerSource" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "changeSummary" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT NOT NULL,
    "error" TEXT,
    "deploymentId" TEXT NOT NULL,
    "rollbackReference" TEXT,
    "graphVersionBefore" INTEGER NOT NULL,
    "graphVersionAfter" INTEGER NOT NULL,

    CONSTRAINT "DeploymentAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_archives" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "archivedName" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "canRestore" BOOLEAN NOT NULL DEFAULT true,
    "dataPreserved" BOOLEAN NOT NULL DEFAULT true,
    "restoredAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "table_archives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pitr_snapshots" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graphState" JSONB NOT NULL,
    "schemaState" JSONB NOT NULL,
    "canRestoreTo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pitr_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_snapshots" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graphState" JSONB NOT NULL,
    "lineageHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshotType" TEXT NOT NULL DEFAULT 'pre_mutation',
    "metadata" JSONB,

    CONSTRAINT "state_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rollback_executions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "targetIntentId" TEXT NOT NULL,
    "targetIntentHash" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "stepsExecuted" INTEGER NOT NULL DEFAULT 0,
    "totalSteps" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "error" TEXT,
    "recoveryAction" TEXT,
    "preRollbackSnapshotId" TEXT,
    "affectedResources" JSONB,
    "timelineEntry" JSONB,

    CONSTRAINT "rollback_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paddle_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paddleSubscriptionId" TEXT NOT NULL,
    "paddleCustomerId" TEXT NOT NULL,
    "paddlePlanId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "nextBillDate" TIMESTAMP(3),
    "cancelUrl" TEXT,
    "updateUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paddle_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_request_logs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oidc_access_tokens" (
    "id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oidc_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_versions" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "schemaHash" TEXT NOT NULL,
    "endpoints" JSONB NOT NULL,
    "schemaSnapshot" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delegated_connections_tokenHash_key" ON "delegated_connections"("tokenHash");

-- CreateIndex
CREATE INDEX "delegated_connections_projectId_idx" ON "delegated_connections"("projectId");

-- CreateIndex
CREATE INDEX "delegated_connections_tokenHash_idx" ON "delegated_connections"("tokenHash");

-- CreateIndex
CREATE INDEX "delegated_connections_provider_idx" ON "delegated_connections"("provider");

-- CreateIndex
CREATE INDEX "delegated_connections_expiresAt_idx" ON "delegated_connections"("expiresAt");

-- CreateIndex
CREATE INDEX "delegated_connections_revokedAt_idx" ON "delegated_connections"("revokedAt");

-- CreateIndex
CREATE INDEX "delegation_audit_logs_connectionId_idx" ON "delegation_audit_logs"("connectionId");

-- CreateIndex
CREATE INDEX "delegation_audit_logs_action_idx" ON "delegation_audit_logs"("action");

-- CreateIndex
CREATE INDEX "delegation_audit_logs_createdAt_idx" ON "delegation_audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "intent_logs_projectId_idx" ON "intent_logs"("projectId");

-- CreateIndex
CREATE INDEX "intent_logs_timestamp_idx" ON "intent_logs"("timestamp");

-- CreateIndex
CREATE INDEX "intent_logs_executionId_idx" ON "intent_logs"("executionId");

-- CreateIndex
CREATE INDEX "intent_logs_rolledBack_idx" ON "intent_logs"("rolledBack");

-- CreateIndex
CREATE INDEX "intent_logs_liveMutation_idx" ON "intent_logs"("liveMutation");

-- CreateIndex
CREATE INDEX "backend_graphs_projectId_idx" ON "backend_graphs"("projectId");

-- CreateIndex
CREATE INDEX "backend_graphs_createdAt_idx" ON "backend_graphs"("createdAt");

-- CreateIndex
CREATE INDEX "backend_graphs_intentId_idx" ON "backend_graphs"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "backend_graphs_projectId_sequenceNumber_key" ON "backend_graphs"("projectId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "project_suggestions_projectId_idx" ON "project_suggestions"("projectId");

-- CreateIndex
CREATE INDEX "project_suggestions_graphId_idx" ON "project_suggestions"("graphId");

-- CreateIndex
CREATE INDEX "Deployment_projectId_idx" ON "Deployment"("projectId");

-- CreateIndex
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");

-- CreateIndex
CREATE INDEX "Deployment_createdAt_idx" ON "Deployment"("createdAt");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_idx" ON "DeploymentLog"("deploymentId");

-- CreateIndex
CREATE INDEX "DeploymentLog_projectId_idx" ON "DeploymentLog"("projectId");

-- CreateIndex
CREATE INDEX "DeploymentLog_timestamp_idx" ON "DeploymentLog"("timestamp");

-- CreateIndex
CREATE INDEX "DeploymentLog_level_idx" ON "DeploymentLog"("level");

-- CreateIndex
CREATE INDEX "DeploymentAudit_projectId_idx" ON "DeploymentAudit"("projectId");

-- CreateIndex
CREATE INDEX "DeploymentAudit_timestamp_idx" ON "DeploymentAudit"("timestamp");

-- CreateIndex
CREATE INDEX "DeploymentAudit_result_idx" ON "DeploymentAudit"("result");

-- CreateIndex
CREATE INDEX "table_archives_projectId_idx" ON "table_archives"("projectId");

-- CreateIndex
CREATE INDEX "table_archives_archivedAt_idx" ON "table_archives"("archivedAt");

-- CreateIndex
CREATE INDEX "table_archives_canRestore_idx" ON "table_archives"("canRestore");

-- CreateIndex
CREATE INDEX "pitr_snapshots_projectId_idx" ON "pitr_snapshots"("projectId");

-- CreateIndex
CREATE INDEX "pitr_snapshots_capturedAt_idx" ON "pitr_snapshots"("capturedAt");

-- CreateIndex
CREATE INDEX "state_snapshots_projectId_idx" ON "state_snapshots"("projectId");

-- CreateIndex
CREATE INDEX "state_snapshots_executionId_idx" ON "state_snapshots"("executionId");

-- CreateIndex
CREATE INDEX "state_snapshots_timestamp_idx" ON "state_snapshots"("timestamp");

-- CreateIndex
CREATE INDEX "state_snapshots_lineageHash_idx" ON "state_snapshots"("lineageHash");

-- CreateIndex
CREATE INDEX "rollback_executions_projectId_idx" ON "rollback_executions"("projectId");

-- CreateIndex
CREATE INDEX "rollback_executions_executionId_idx" ON "rollback_executions"("executionId");

-- CreateIndex
CREATE INDEX "rollback_executions_targetIntentId_idx" ON "rollback_executions"("targetIntentId");

-- CreateIndex
CREATE INDEX "rollback_executions_timestamp_idx" ON "rollback_executions"("timestamp");

-- CreateIndex
CREATE INDEX "rollback_executions_success_idx" ON "rollback_executions"("success");

-- CreateIndex
CREATE UNIQUE INDEX "paddle_subscriptions_paddleSubscriptionId_key" ON "paddle_subscriptions"("paddleSubscriptionId");

-- CreateIndex
CREATE INDEX "paddle_subscriptions_userId_idx" ON "paddle_subscriptions"("userId");

-- CreateIndex
CREATE INDEX "paddle_subscriptions_paddleSubscriptionId_idx" ON "paddle_subscriptions"("paddleSubscriptionId");

-- CreateIndex
CREATE INDEX "paddle_subscriptions_paddleCustomerId_idx" ON "paddle_subscriptions"("paddleCustomerId");

-- CreateIndex
CREATE INDEX "paddle_subscriptions_status_idx" ON "paddle_subscriptions"("status");

-- CreateIndex
CREATE INDEX "api_request_logs_projectId_timestamp_idx" ON "api_request_logs"("projectId", "timestamp");

-- CreateIndex
CREATE INDEX "api_request_logs_userId_timestamp_idx" ON "api_request_logs"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "api_request_logs_timestamp_idx" ON "api_request_logs"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_code_key" ON "oauth_authorization_codes"("code");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_code_idx" ON "oauth_authorization_codes"("code");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_projectId_idx" ON "oauth_authorization_codes"("projectId");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_clientId_idx" ON "oauth_authorization_codes"("clientId");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_expiresAt_idx" ON "oauth_authorization_codes"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_access_tokens_jti_key" ON "oidc_access_tokens"("jti");

-- CreateIndex
CREATE INDEX "oidc_access_tokens_jti_idx" ON "oidc_access_tokens"("jti");

-- CreateIndex
CREATE INDEX "oidc_access_tokens_projectId_idx" ON "oidc_access_tokens"("projectId");

-- CreateIndex
CREATE INDEX "oidc_access_tokens_clientId_idx" ON "oidc_access_tokens"("clientId");

-- CreateIndex
CREATE INDEX "oidc_access_tokens_expiresAt_idx" ON "oidc_access_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_versions_versionId_key" ON "api_versions"("versionId");

-- CreateIndex
CREATE INDEX "api_versions_projectId_idx" ON "api_versions"("projectId");

-- CreateIndex
CREATE INDEX "api_versions_tableId_idx" ON "api_versions"("tableId");

-- CreateIndex
CREATE INDEX "api_versions_versionId_idx" ON "api_versions"("versionId");

-- CreateIndex
CREATE INDEX "api_versions_schemaHash_idx" ON "api_versions"("schemaHash");

-- CreateIndex
CREATE UNIQUE INDEX "api_versions_projectId_tableId_schemaHash_key" ON "api_versions"("projectId", "tableId", "schemaHash");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_activeGraphId_fkey" FOREIGN KEY ("activeGraphId") REFERENCES "backend_graphs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegated_connections" ADD CONSTRAINT "delegated_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_audit_logs" ADD CONSTRAINT "delegation_audit_logs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "delegated_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intent_logs" ADD CONSTRAINT "intent_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backend_graphs" ADD CONSTRAINT "backend_graphs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_providerCredentialId_fkey" FOREIGN KEY ("providerCredentialId") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentAudit" ADD CONSTRAINT "DeploymentAudit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paddle_subscriptions" ADD CONSTRAINT "paddle_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
