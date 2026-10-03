-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PRIVATE', 'DEPLOYING', 'LIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "AutonomyLevel" AS ENUM ('OFF', 'CONSERVATIVE', 'BALANCED', 'AGGRESSIVE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'FREE', 'GRACE', 'CANCELED', 'PAST_DUE');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'RETRYING', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "TriggerDeliveryStatus" AS ENUM ('SUCCESS', 'FAILED', 'DEAD');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'email',
    "providerId" TEXT,
    "lastLogin" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "roleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspensionReason" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "bonusCredits" INTEGER NOT NULL DEFAULT 0,
    "bonusReconciledThrough" TEXT,
    "referredById" TEXT,
    "trustLevel" TEXT NOT NULL DEFAULT 'trusted',
    "signupScore" INTEGER,
    "signupSignals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signupIp" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'development',
    "apiUrlDev" TEXT,
    "apiUrlStaging" TEXT,
    "apiUrlProd" TEXT,
    "apiRequests" INTEGER NOT NULL DEFAULT 0,
    "avgLatency" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "storageUsed" BIGINT NOT NULL DEFAULT 0,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "activeUsers" INTEGER NOT NULL DEFAULT 0,
    "lastMetricsUpdate" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "maxFileSize" BIGINT NOT NULL DEFAULT 10485760,
    "maxFilesPerBucket" INTEGER NOT NULL DEFAULT 1000,
    "publicEnabled" BOOLEAN NOT NULL DEFAULT false,
    "slug" TEXT,
    "storageLimit" BIGINT NOT NULL DEFAULT 1073741824,
    "customDomain" TEXT,
    "domainVerificationToken" TEXT,
    "domainVerified" BOOLEAN NOT NULL DEFAULT false,
    "subdomain" TEXT,
    "workerContainerId" TEXT,
    "workerPort" INTEGER,
    "jwtSecret" TEXT,
    "anonKey" TEXT,
    "authManifest" JSONB,
    "architecturalMemory" TEXT,
    "projectBrain" TEXT,
    "deployedAt" TIMESTAMP(3),
    "deploymentError" TEXT,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "lockedDownAt" TIMESTAMP(3),
    "lockedDownReason" TEXT,
    "isDeployed" BOOLEAN NOT NULL DEFAULT false,
    "isBackendGenerated" BOOLEAN NOT NULL DEFAULT false,
    "isFrontendConnected" BOOLEAN NOT NULL DEFAULT false,
    "hasExternalUsers" BOOLEAN NOT NULL DEFAULT false,
    "activeIntegrations" JSONB,
    "projectStatus" "ProjectStatus" NOT NULL DEFAULT 'PRIVATE',
    "autonomyLevel" "AutonomyLevel" NOT NULL DEFAULT 'AGGRESSIVE',
    "publicUrl" TEXT,
    "activeGraphId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_integration_keys" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "maskedKey" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "verification" TEXT NOT NULL DEFAULT 'unchecked',
    "verificationDetail" TEXT,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "project_integration_keys_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "project_metadata" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "originalPrompt" TEXT NOT NULL,
    "entities" JSONB NOT NULL,
    "relationships" JSONB NOT NULL,
    "behaviors" JSONB NOT NULL,
    "security" JSONB NOT NULL,
    "tablePlans" JSONB NOT NULL,
    "apiPlans" JSONB NOT NULL,
    "tablesCreated" BOOLEAN NOT NULL DEFAULT false,
    "apisCreated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "backendStateGraph" JSONB,

    CONSTRAINT "project_metadata_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "db_baseline_samples" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "db_baseline_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schema_intents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT NOT NULL,
    "requestedType" TEXT NOT NULL,
    "requestedNullable" BOOLEAN,
    "requestedUnique" BOOLEAN,
    "requestedFkTo" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schema_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backend_events" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "summary" TEXT NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "reason" TEXT,
    "risk_level" TEXT NOT NULL DEFAULT 'low',
    "status" TEXT NOT NULL DEFAULT 'applied',
    "receipt_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backend_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backend_patterns" (
    "id" TEXT NOT NULL,
    "project_type" TEXT NOT NULL,
    "pattern_type" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "pattern_summary" TEXT NOT NULL,
    "frequency" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "risk_score" TEXT NOT NULL DEFAULT 'low',
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backend_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_receipts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "event_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "resources_changed" JSONB,
    "risk_level" TEXT NOT NULL DEFAULT 'low',
    "rollback_available" BOOLEAN NOT NULL DEFAULT false,
    "rollback_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backend_graphs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "graphData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "intentId" TEXT,
    "sequenceNumber" INTEGER NOT NULL DEFAULT 0,
    "parentId" TEXT,

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
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT,
    "refreshToken" TEXT,
    "refreshTokenExpiresAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_backup_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_backup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'development',
    "apiBaseUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "totalRoutes" INTEGER NOT NULL DEFAULT 0,
    "totalFunctions" INTEGER NOT NULL DEFAULT 0,
    "lastActivity" TIMESTAMP(3),
    "databaseProvisioned" BOOLEAN NOT NULL DEFAULT false,
    "databaseProvisionedAt" TIMESTAMP(3),
    "mongodbDatabase" TEXT,
    "postgresSchema" TEXT,
    "deployTarget" TEXT NOT NULL DEFAULT 'node',
    "language" TEXT NOT NULL DEFAULT 'typescript',
    "runtime" TEXT NOT NULL DEFAULT 'express',
    "runtimeLocked" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "tables" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schema" TEXT NOT NULL DEFAULT 'public',
    "description" TEXT,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_issues" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "impact" TEXT,
    "suggestedFix" TEXT NOT NULL,
    "rawQuery" TEXT,
    "affectedTables" TEXT[],
    "estimatedImpact" TEXT,
    "detailedAnalysis" TEXT,
    "whyItHappened" TEXT,
    "sqlFix" TEXT,
    "migrationSteps" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "configured" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL,
    "clientId" TEXT,
    "clientSecret" TEXT,
    "redirectUri" TEXT,
    "scopes" TEXT[],
    "icon" TEXT,
    "warning" TEXT,
    "codeGenerated" BOOLEAN NOT NULL DEFAULT false,
    "lastModified" TIMESTAMP(3),
    "modifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_providers_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'client',
    "permissions" TEXT[],
    "userId" TEXT NOT NULL,
    "lastUsed" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "rateLimit" INTEGER NOT NULL DEFAULT 1000,
    "rateLimitWindow" INTEGER NOT NULL DEFAULT 3600,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "capabilities" TEXT[],
    "keyType" TEXT NOT NULL DEFAULT 'public',
    "projectId" TEXT,
    "serviceRole" BOOLEAN NOT NULL DEFAULT false,
    "keyHash" TEXT NOT NULL,
    "key" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'runtime',
    "mcpReadOnly" BOOLEAN NOT NULL DEFAULT false,
    "mcpClientLabel" TEXT,
    "branchId" TEXT,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key_usage" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseTime" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "api_key_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "userEmail" TEXT,
    "details" TEXT,
    "metadata" JSONB,
    "projectId" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "value" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anomalies" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "expectedValue" DOUBLE PRECISION NOT NULL,
    "deviation" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "explanation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "affectedServices" TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "projectId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "service" TEXT,
    "endpoint" TEXT,
    "method" TEXT,
    "statusCode" INTEGER,
    "userId" TEXT,
    "projectId" TEXT,
    "metadata" JSONB,
    "stackTrace" TEXT,
    "duration" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_issues" (
    "id" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fixed" BOOLEAN NOT NULL DEFAULT false,
    "fixedAt" TIMESTAMP(3),
    "fixedBy" TEXT,
    "projectId" TEXT NOT NULL,
    "metadata" JSONB,
    "aiFixPreview" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_attacks" (
    "id" TEXT NOT NULL,
    "attackType" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "endpoint" TEXT,
    "method" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestBody" TEXT,
    "blockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_attacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_scans" (
    "id" TEXT NOT NULL,
    "scanType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "issuesFound" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER,
    "projectId" TEXT NOT NULL,
    "metadata" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_buckets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "accessPolicy" TEXT NOT NULL DEFAULT 'private',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "allowedExtensions" TEXT[] DEFAULT ARRAY['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.txt', '.csv']::TEXT[],
    "allowedMimeTypes" TEXT[] DEFAULT ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv']::TEXT[],
    "blockExecutables" BOOLEAN NOT NULL DEFAULT true,
    "maxFileSizeBytes" BIGINT NOT NULL DEFAULT 10485760,
    "overwriteStrategy" TEXT NOT NULL DEFAULT 'auto_rename',

    CONSTRAINT "storage_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_files" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mimeType" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "uploadedBy" TEXT,
    "projectId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "originalName" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "processingStatus" TEXT,
    "processingResult" JSONB,

    CONSTRAINT "storage_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "multipart_uploads" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "uploadId" TEXT NOT NULL,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalSize" BIGINT NOT NULL DEFAULT 0,
    "chunkSize" INTEGER NOT NULL DEFAULT 10485760,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "multipart_uploads_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "user_ai_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "intentCount" INTEGER NOT NULL DEFAULT 0,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "apiRequestCount" BIGINT NOT NULL DEFAULT 0,
    "aiFunctionInvocations" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_active_users" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "endUserId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_active_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reservations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 1,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "credit_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_grants" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "refereeEmail" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'signup_granted',
    "signupCreditsGranted" INTEGER NOT NULL DEFAULT 0,
    "payCreditsGranted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'DEVELOPER',
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invites" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'DEVELOPER',
    "token" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "scopedProjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invites_pkey" PRIMARY KEY ("id")
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
    "version" INTEGER,
    "graphSnapshotId" TEXT,
    "changeSummary" TEXT,
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
CREATE TABLE "deploy_confirmations" (
    "id" TEXT NOT NULL,
    "confirmationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "diff" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deploy_confirmations_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "api_definitions" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'v1',
    "basePath" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "authRequired" BOOLEAN NOT NULL DEFAULT true,
    "authStrategy" TEXT,
    "rateLimit" INTEGER DEFAULT 100,
    "operations" JSONB NOT NULL,
    "endpoints" JSONB NOT NULL,
    "validation" JSONB,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "api_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage_logs" (
    "id" TEXT NOT NULL,
    "apiDefinitionId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseTime" INTEGER,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "api_usage_logs_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "workspace_branches" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schemaName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),

    CONSTRAINT "workspace_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_tokens" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'change_report',
    "tokenHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),

    CONSTRAINT "share_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_approval_requests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "message" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "rowCount" INTEGER,
    "reversible" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "resultSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_approval_requests_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "annualPriceCents" INTEGER,
    "maxProjects" INTEGER,
    "maxMonthlyActiveUsers" INTEGER,
    "maxAiBuildActionsPerMonth" INTEGER,
    "monthlyAiCredits" INTEGER,
    "autonomyScanIntervalMin" INTEGER NOT NULL DEFAULT 1,
    "autonomyMonthlyScanBudget" INTEGER,
    "autonomyMaxLevel" TEXT NOT NULL DEFAULT 'AGGRESSIVE',
    "autonomyMaxActionsPerWindow" INTEGER,
    "maxApiRequestsPerMonth" BIGINT,
    "apiQuotaIsLifetime" BOOLEAN NOT NULL DEFAULT false,
    "maxPostgresStorageMb" INTEGER,
    "maxFileStorageMb" INTEGER,
    "maxRealtimeConnections" INTEGER,
    "maxAiFunctionInvocationsPerMonth" INTEGER,
    "maxTriggersPerProject" INTEGER,
    "maxTeamSeats" INTEGER NOT NULL DEFAULT 1,
    "maxDeploymentHistory" INTEGER,
    "logRetentionDays" INTEGER NOT NULL DEFAULT 7,
    "supportResponseHours" INTEGER,
    "allowedAuthProviders" TEXT[] DEFAULT ARRAY['email', 'google']::TEXT[],
    "allowCustomDomain" BOOLEAN NOT NULL DEFAULT false,
    "allowAdvancedMonitoring" BOOLEAN NOT NULL DEFAULT false,
    "allowRbac" BOOLEAN NOT NULL DEFAULT false,
    "allowSso" BOOLEAN NOT NULL DEFAULT false,
    "allowDeploymentRollback" BOOLEAN NOT NULL DEFAULT false,
    "allowWebhooks" BOOLEAN NOT NULL DEFAULT false,
    "prioritySupport" BOOLEAN NOT NULL DEFAULT false,
    "allowDeployment" BOOLEAN NOT NULL DEFAULT true,
    "isSandboxPlan" BOOLEAN NOT NULL DEFAULT false,
    "sandboxExpiryDays" INTEGER,
    "isPayAsYouGo" BOOLEAN NOT NULL DEFAULT false,
    "maxRowsPerProject" INTEGER,
    "apiRateLimitPerMin" INTEGER NOT NULL DEFAULT 60,
    "maxAiIntentsPerDay" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "paddleSubscriptionId" TEXT,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'FREE',
    "currentPeriodEnd" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "cancelScheduledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_logs" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "error" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_domains" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "dnsRecordType" TEXT NOT NULL DEFAULT 'TXT',
    "dnsRecordValue" TEXT NOT NULL,
    "sslEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sslCertUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connected_apps" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "connectedBy" TEXT NOT NULL,
    "backendVersion" INTEGER NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "connected_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_env_vars" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueCipher" TEXT NOT NULL,
    "valueIv" TEXT NOT NULL,
    "valueTag" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "project_env_vars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageSeq" BIGSERIAL NOT NULL,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'streaming',
    "nextSeq" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "chat_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_run_events" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_triggers" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sourceTable" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "conditions" JSONB,
    "actionType" TEXT NOT NULL,
    "targetTable" TEXT,
    "fieldMappings" JSONB,
    "staticFields" JSONB,
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_policies" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "policyName" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'authenticated',
    "using" TEXT,
    "withCheck" TEXT,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permission_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_functions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "generatedCode" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerTable" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastRun" TIMESTAMP(3),
    "lastError" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_functions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_function_logs" (
    "id" TEXT NOT NULL,
    "functionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "logs" TEXT[],
    "error" TEXT,
    "durationMs" INTEGER NOT NULL,
    "triggerType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_function_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_backups" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "schemaName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_webhook_events" (
    "id" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "jti" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "platform_notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autonomous_actions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "appliedFixes" JSONB NOT NULL,
    "pendingReview" JSONB NOT NULL,
    "seenByUser" BOOLEAN NOT NULL DEFAULT false,
    "seenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autonomous_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_usage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "apiUnitsUsed" BIGINT NOT NULL DEFAULT 0,
    "dbStorageUsedMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fileStorageUsedMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realtimeEvents" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_bills" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "apiCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dbCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "storageCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realtimeCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalUsageCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "finalCost" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "overage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paddleChargeId" TEXT,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_delivery_logs" (
    "id" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "table" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TriggerDeliveryStatus" NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "statusCode" INTEGER,
    "error" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trigger_delivery_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "eventType" TEXT NOT NULL,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_metrics" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "dbReads" INTEGER NOT NULL DEFAULT 0,
    "dbWrites" INTEGER NOT NULL DEFAULT 0,
    "computeTime" INTEGER NOT NULL DEFAULT 0,
    "storageUsed" BIGINT NOT NULL DEFAULT 0,
    "aiCalls" INTEGER NOT NULL DEFAULT 0,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memories" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "sampleGoal" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 1,
    "lastUsed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_logs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "intent" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "errorMsg" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_preferences" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "positiveSignals" INTEGER NOT NULL DEFAULT 1,
    "negativeSignals" INTEGER NOT NULL DEFAULT 0,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_rejection_patterns" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "lastRejected" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_rejection_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_cancellations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "convId" TEXT NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_timeline_entries" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "executionId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionParams" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "selfCorrected" BOOLEAN NOT NULL DEFAULT false,
    "errorClassification" TEXT,
    "errorMessage" TEXT,
    "healingApplied" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_timeline_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_events" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "originalExecutionId" TEXT,
    "originalActionType" TEXT NOT NULL,
    "originalActionParams" JSONB,
    "correctionType" TEXT NOT NULL,
    "correctionDetail" JSONB,
    "domain" TEXT,
    "errorClassification" TEXT,
    "elapsedMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correction_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_patterns" (
    "id" TEXT NOT NULL,
    "domain" TEXT,
    "actionType" TEXT NOT NULL,
    "errorClassification" TEXT,
    "patternSummary" TEXT NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "exampleIds" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "ruleHint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "correction_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_jobs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "timeoutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schema_versions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionNum" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schema_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_findings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT,
    "source" TEXT,
    "details" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "autoFixed" BOOLEAN NOT NULL DEFAULT false,
    "fixAppliedAt" TIMESTAMP(3),

    CONSTRAINT "health_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_schema_snapshots" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionNum" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "tables" JSONB NOT NULL,
    "rawDdl" TEXT NOT NULL,
    "tableCount" INTEGER NOT NULL DEFAULT 0,
    "columnCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_schema_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_workflows" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_input',
    "provider" TEXT,
    "action" TEXT,
    "buildJobId" TEXT,
    "requiredInputs" JSONB NOT NULL DEFAULT '{}',
    "validationRules" JSONB NOT NULL DEFAULT '{}',
    "context" JSONB NOT NULL DEFAULT '{}',
    "collectedInputs" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_controls" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "aiFrozen" BOOLEAN NOT NULL DEFAULT false,
    "signupsDisabled" BOOLEAN NOT NULL DEFAULT false,
    "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "platform_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocklist" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "blocklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "userId" TEXT,
    "userEmail" TEXT,
    "projectId" TEXT,
    "ip" TEXT,
    "summary" TEXT NOT NULL,
    "detail" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unsupported_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "projectId" TEXT,
    "category" TEXT NOT NULL,
    "promptExcerpt" TEXT NOT NULL,
    "refusalMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unsupported_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_auth_configs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "appName" TEXT,
    "appUrl" TEXT,
    "requireEmailVerification" BOOLEAN NOT NULL DEFAULT false,
    "magicLinksEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_auth_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_credentials" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "passwordCipher" TEXT NOT NULL,
    "passwordIv" TEXT NOT NULL,
    "passwordTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "database_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schema_drift_events" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "roleName" TEXT NOT NULL,
    "commandTag" TEXT NOT NULL,
    "objectType" TEXT,
    "objectIdentity" TEXT,
    "schemaName" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolvedAt" TIMESTAMP(3),
    "findingId" TEXT,

    CONSTRAINT "schema_drift_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_clients" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resource" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_refresh_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "rotatedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_provider_providerId_idx" ON "users"("provider", "providerId");

-- CreateIndex
CREATE INDEX "users_tokenVersion_idx" ON "users"("tokenVersion");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE INDEX "users_suspendedAt_idx" ON "users"("suspendedAt");

-- CreateIndex
CREATE INDEX "users_lockedUntil_idx" ON "users"("lockedUntil");

-- CreateIndex
CREATE INDEX "users_lastActiveAt_idx" ON "users"("lastActiveAt");

-- CreateIndex
CREATE INDEX "users_referredById_idx" ON "users"("referredById");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "projects_customDomain_key" ON "projects"("customDomain");

-- CreateIndex
CREATE UNIQUE INDEX "projects_subdomain_key" ON "projects"("subdomain");

-- CreateIndex
CREATE INDEX "projects_userId_idx" ON "projects"("userId");

-- CreateIndex
CREATE INDEX "projects_updatedAt_idx" ON "projects"("updatedAt");

-- CreateIndex
CREATE INDEX "projects_expiresAt_idx" ON "projects"("expiresAt");

-- CreateIndex
CREATE INDEX "projects_deletedAt_idx" ON "projects"("deletedAt");

-- CreateIndex
CREATE INDEX "projects_organizationId_idx" ON "projects"("organizationId");

-- CreateIndex
CREATE INDEX "project_integration_keys_projectId_idx" ON "project_integration_keys"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_integration_keys_projectId_integrationId_key" ON "project_integration_keys"("projectId", "integrationId");

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
CREATE UNIQUE INDEX "project_metadata_projectId_key" ON "project_metadata"("projectId");

-- CreateIndex
CREATE INDEX "project_metadata_projectId_idx" ON "project_metadata"("projectId");

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
CREATE INDEX "db_baseline_samples_projectId_kind_bucket_idx" ON "db_baseline_samples"("projectId", "kind", "bucket");

-- CreateIndex
CREATE INDEX "db_baseline_samples_bucket_idx" ON "db_baseline_samples"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "db_baseline_samples_projectId_kind_subject_bucket_key" ON "db_baseline_samples"("projectId", "kind", "subject", "bucket");

-- CreateIndex
CREATE INDEX "schema_intents_projectId_idx" ON "schema_intents"("projectId");

-- CreateIndex
CREATE INDEX "schema_intents_projectId_tableName_idx" ON "schema_intents"("projectId", "tableName");

-- CreateIndex
CREATE UNIQUE INDEX "schema_intents_projectId_tableName_columnName_key" ON "schema_intents"("projectId", "tableName", "columnName");

-- CreateIndex
CREATE INDEX "backend_events_project_id_created_at_idx" ON "backend_events"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "backend_events_project_id_event_type_idx" ON "backend_events"("project_id", "event_type");

-- CreateIndex
CREATE INDEX "backend_events_project_id_status_idx" ON "backend_events"("project_id", "status");

-- CreateIndex
CREATE INDEX "backend_events_event_type_idx" ON "backend_events"("event_type");

-- CreateIndex
CREATE INDEX "backend_events_risk_level_idx" ON "backend_events"("risk_level");

-- CreateIndex
CREATE INDEX "backend_events_receipt_id_idx" ON "backend_events"("receipt_id");

-- CreateIndex
CREATE INDEX "backend_patterns_project_type_idx" ON "backend_patterns"("project_type");

-- CreateIndex
CREATE INDEX "backend_patterns_pattern_type_idx" ON "backend_patterns"("pattern_type");

-- CreateIndex
CREATE INDEX "backend_patterns_risk_score_idx" ON "backend_patterns"("risk_score");

-- CreateIndex
CREATE UNIQUE INDEX "backend_patterns_project_type_pattern_type_resource_type_key" ON "backend_patterns"("project_type", "pattern_type", "resource_type");

-- CreateIndex
CREATE INDEX "change_receipts_project_id_created_at_idx" ON "change_receipts"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "change_receipts_project_id_risk_level_idx" ON "change_receipts"("project_id", "risk_level");

-- CreateIndex
CREATE INDEX "change_receipts_rollback_available_idx" ON "change_receipts"("rollback_available");

-- CreateIndex
CREATE INDEX "backend_graphs_parentId_idx" ON "backend_graphs"("parentId");

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
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refreshToken_key" ON "sessions"("refreshToken");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_projectId_idx" ON "sessions"("projectId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "sessions_refreshToken_idx" ON "sessions"("refreshToken");

-- CreateIndex
CREATE INDEX "two_factor_backup_codes_userId_idx" ON "two_factor_backup_codes"("userId");

-- CreateIndex
CREATE INDEX "workspaces_userId_idx" ON "workspaces"("userId");

-- CreateIndex
CREATE INDEX "workspaces_runtime_idx" ON "workspaces"("runtime");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_projectId_key" ON "workspaces"("projectId");

-- CreateIndex
CREATE INDEX "workspace_files_projectId_idx" ON "workspace_files"("projectId");

-- CreateIndex
CREATE INDEX "workspace_files_category_idx" ON "workspace_files"("category");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_files_projectId_path_key" ON "workspace_files"("projectId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "tables_name_schema_projectId_key" ON "tables"("name", "schema", "projectId");

-- CreateIndex
CREATE INDEX "database_issues_projectId_idx" ON "database_issues"("projectId");

-- CreateIndex
CREATE INDEX "database_issues_severity_idx" ON "database_issues"("severity");

-- CreateIndex
CREATE INDEX "database_issues_status_idx" ON "database_issues"("status");

-- CreateIndex
CREATE INDEX "database_issues_database_idx" ON "database_issues"("database");

-- CreateIndex
CREATE INDEX "database_issues_projectId_status_idx" ON "database_issues"("projectId", "status");

-- CreateIndex
CREATE INDEX "database_issues_projectId_severity_idx" ON "database_issues"("projectId", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "auth_providers_name_key" ON "auth_providers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "auth_policies_name_key" ON "auth_policies"("name");

-- CreateIndex
CREATE INDEX "workspace_oauth_configs_projectId_idx" ON "workspace_oauth_configs"("projectId");

-- CreateIndex
CREATE INDEX "workspace_oauth_configs_provider_idx" ON "workspace_oauth_configs"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_oauth_configs_projectId_provider_key" ON "workspace_oauth_configs"("projectId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");

-- CreateIndex
CREATE INDEX "api_keys_projectId_idx" ON "api_keys"("projectId");

-- CreateIndex
CREATE INDEX "api_keys_keyPrefix_idx" ON "api_keys"("keyPrefix");

-- CreateIndex
CREATE INDEX "api_keys_keyType_idx" ON "api_keys"("keyType");

-- CreateIndex
CREATE INDEX "api_keys_branchId_idx" ON "api_keys"("branchId");

-- CreateIndex
CREATE INDEX "api_keys_resetAt_idx" ON "api_keys"("resetAt");

-- CreateIndex
CREATE INDEX "api_keys_keyHash_idx" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_scope_idx" ON "api_keys"("scope");

-- CreateIndex
CREATE INDEX "api_key_usage_apiKeyId_idx" ON "api_key_usage"("apiKeyId");

-- CreateIndex
CREATE INDEX "api_key_usage_timestamp_idx" ON "api_key_usage"("timestamp");

-- CreateIndex
CREATE INDEX "api_key_usage_endpoint_idx" ON "api_key_usage"("endpoint");

-- CreateIndex
CREATE INDEX "roles_projectId_idx" ON "roles"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_projectId_key" ON "roles"("name", "projectId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_projectId_idx" ON "audit_logs"("projectId");

-- CreateIndex
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_type_idx" ON "audit_logs"("type");

-- CreateIndex
CREATE INDEX "metrics_type_idx" ON "metrics"("type");

-- CreateIndex
CREATE INDEX "metrics_source_idx" ON "metrics"("source");

-- CreateIndex
CREATE INDEX "metrics_timestamp_idx" ON "metrics"("timestamp");

-- CreateIndex
CREATE INDEX "metrics_projectId_idx" ON "metrics"("projectId");

-- CreateIndex
CREATE INDEX "anomalies_type_idx" ON "anomalies"("type");

-- CreateIndex
CREATE INDEX "anomalies_status_idx" ON "anomalies"("status");

-- CreateIndex
CREATE INDEX "anomalies_timestamp_idx" ON "anomalies"("timestamp");

-- CreateIndex
CREATE INDEX "anomalies_projectId_idx" ON "anomalies"("projectId");

-- CreateIndex
CREATE INDEX "incidents_status_idx" ON "incidents"("status");

-- CreateIndex
CREATE INDEX "incidents_severity_idx" ON "incidents"("severity");

-- CreateIndex
CREATE INDEX "incidents_startedAt_idx" ON "incidents"("startedAt");

-- CreateIndex
CREATE INDEX "incidents_projectId_idx" ON "incidents"("projectId");

-- CreateIndex
CREATE INDEX "logs_type_idx" ON "logs"("type");

-- CreateIndex
CREATE INDEX "logs_severity_idx" ON "logs"("severity");

-- CreateIndex
CREATE INDEX "logs_service_idx" ON "logs"("service");

-- CreateIndex
CREATE INDEX "logs_timestamp_idx" ON "logs"("timestamp");

-- CreateIndex
CREATE INDEX "logs_projectId_idx" ON "logs"("projectId");

-- CreateIndex
CREATE INDEX "logs_userId_idx" ON "logs"("userId");

-- CreateIndex
CREATE INDEX "logs_endpoint_idx" ON "logs"("endpoint");

-- CreateIndex
CREATE INDEX "security_issues_severity_idx" ON "security_issues"("severity");

-- CreateIndex
CREATE INDEX "security_issues_category_idx" ON "security_issues"("category");

-- CreateIndex
CREATE INDEX "security_issues_fixed_idx" ON "security_issues"("fixed");

-- CreateIndex
CREATE INDEX "security_issues_projectId_idx" ON "security_issues"("projectId");

-- CreateIndex
CREATE INDEX "security_issues_detectedAt_idx" ON "security_issues"("detectedAt");

-- CreateIndex
CREATE INDEX "blocked_attacks_attackType_idx" ON "blocked_attacks"("attackType");

-- CreateIndex
CREATE INDEX "blocked_attacks_endpoint_idx" ON "blocked_attacks"("endpoint");

-- CreateIndex
CREATE INDEX "blocked_attacks_blockedAt_idx" ON "blocked_attacks"("blockedAt");

-- CreateIndex
CREATE INDEX "blocked_attacks_projectId_idx" ON "blocked_attacks"("projectId");

-- CreateIndex
CREATE INDEX "blocked_attacks_ipAddress_idx" ON "blocked_attacks"("ipAddress");

-- CreateIndex
CREATE INDEX "security_scans_scanType_idx" ON "security_scans"("scanType");

-- CreateIndex
CREATE INDEX "security_scans_status_idx" ON "security_scans"("status");

-- CreateIndex
CREATE INDEX "security_scans_startedAt_idx" ON "security_scans"("startedAt");

-- CreateIndex
CREATE INDEX "security_scans_projectId_idx" ON "security_scans"("projectId");

-- CreateIndex
CREATE INDEX "storage_buckets_projectId_idx" ON "storage_buckets"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "storage_buckets_name_projectId_key" ON "storage_buckets"("name", "projectId");

-- CreateIndex
CREATE INDEX "storage_files_bucketId_idx" ON "storage_files"("bucketId");

-- CreateIndex
CREATE INDEX "storage_files_projectId_idx" ON "storage_files"("projectId");

-- CreateIndex
CREATE INDEX "storage_files_name_idx" ON "storage_files"("name");

-- CreateIndex
CREATE INDEX "storage_files_createdAt_idx" ON "storage_files"("createdAt");

-- CreateIndex
CREATE INDEX "storage_files_deletedAt_idx" ON "storage_files"("deletedAt");

-- CreateIndex
CREATE INDEX "storage_files_processingStatus_idx" ON "storage_files"("processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "multipart_uploads_uploadId_key" ON "multipart_uploads"("uploadId");

-- CreateIndex
CREATE INDEX "multipart_uploads_projectId_idx" ON "multipart_uploads"("projectId");

-- CreateIndex
CREATE INDEX "multipart_uploads_bucketId_idx" ON "multipart_uploads"("bucketId");

-- CreateIndex
CREATE INDEX "multipart_uploads_uploadId_idx" ON "multipart_uploads"("uploadId");

-- CreateIndex
CREATE INDEX "multipart_uploads_status_idx" ON "multipart_uploads"("status");

-- CreateIndex
CREATE INDEX "multipart_uploads_expiresAt_idx" ON "multipart_uploads"("expiresAt");

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
CREATE INDEX "user_ai_usage_userId_idx" ON "user_ai_usage"("userId");

-- CreateIndex
CREATE INDEX "user_ai_usage_date_idx" ON "user_ai_usage"("date");

-- CreateIndex
CREATE UNIQUE INDEX "user_ai_usage_userId_date_key" ON "user_ai_usage"("userId", "date");

-- CreateIndex
CREATE INDEX "project_active_users_projectId_month_idx" ON "project_active_users"("projectId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "project_active_users_projectId_endUserId_month_key" ON "project_active_users"("projectId", "endUserId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "credit_reservations_jobId_key" ON "credit_reservations"("jobId");

-- CreateIndex
CREATE INDEX "credit_reservations_userId_date_idx" ON "credit_reservations"("userId", "date");

-- CreateIndex
CREATE INDEX "credit_reservations_jobId_idx" ON "credit_reservations"("jobId");

-- CreateIndex
CREATE INDEX "credit_reservations_status_expiresAt_idx" ON "credit_reservations"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "credit_ledger_entries_userId_createdAt_idx" ON "credit_ledger_entries"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_userId_key" ON "referral_codes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_codes_code_idx" ON "referral_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referral_grants_refereeId_key" ON "referral_grants"("refereeId");

-- CreateIndex
CREATE INDEX "referral_grants_referrerId_idx" ON "referral_grants"("referrerId");

-- CreateIndex
CREATE INDEX "referral_grants_code_idx" ON "referral_grants"("code");

-- CreateIndex
CREATE INDEX "organizations_ownerId_idx" ON "organizations"("ownerId");

-- CreateIndex
CREATE INDEX "organization_members_userId_idx" ON "organization_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_orgId_userId_key" ON "organization_members"("orgId", "userId");

-- CreateIndex
CREATE INDEX "project_members_orgId_userId_idx" ON "project_members"("orgId", "userId");

-- CreateIndex
CREATE INDEX "project_members_projectId_idx" ON "project_members"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_userId_projectId_key" ON "project_members"("userId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invites_token_key" ON "organization_invites"("token");

-- CreateIndex
CREATE INDEX "organization_invites_orgId_status_idx" ON "organization_invites"("orgId", "status");

-- CreateIndex
CREATE INDEX "organization_invites_email_idx" ON "organization_invites"("email");

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
CREATE UNIQUE INDEX "deploy_confirmations_confirmationId_key" ON "deploy_confirmations"("confirmationId");

-- CreateIndex
CREATE INDEX "deploy_confirmations_projectId_status_idx" ON "deploy_confirmations"("projectId", "status");

-- CreateIndex
CREATE INDEX "deploy_confirmations_confirmationId_idx" ON "deploy_confirmations"("confirmationId");

-- CreateIndex
CREATE INDEX "deploy_confirmations_expiresAt_idx" ON "deploy_confirmations"("expiresAt");

-- CreateIndex
CREATE INDEX "provider_credentials_projectId_idx" ON "provider_credentials"("projectId");

-- CreateIndex
CREATE INDEX "provider_credentials_provider_idx" ON "provider_credentials"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credentials_projectId_provider_key" ON "provider_credentials"("projectId", "provider");

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
CREATE UNIQUE INDEX "api_definitions_tableId_key" ON "api_definitions"("tableId");

-- CreateIndex
CREATE INDEX "api_definitions_projectId_idx" ON "api_definitions"("projectId");

-- CreateIndex
CREATE INDEX "api_definitions_enabled_idx" ON "api_definitions"("enabled");

-- CreateIndex
CREATE INDEX "api_definitions_version_idx" ON "api_definitions"("version");

-- CreateIndex
CREATE UNIQUE INDEX "api_definitions_projectId_name_version_key" ON "api_definitions"("projectId", "name", "version");

-- CreateIndex
CREATE INDEX "api_usage_logs_apiDefinitionId_idx" ON "api_usage_logs"("apiDefinitionId");

-- CreateIndex
CREATE INDEX "api_usage_logs_timestamp_idx" ON "api_usage_logs"("timestamp");

-- CreateIndex
CREATE INDEX "api_usage_logs_endpoint_idx" ON "api_usage_logs"("endpoint");

-- CreateIndex
CREATE INDEX "api_usage_logs_userId_idx" ON "api_usage_logs"("userId");

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
CREATE UNIQUE INDEX "workspace_branches_schemaName_key" ON "workspace_branches"("schemaName");

-- CreateIndex
CREATE INDEX "workspace_branches_projectId_status_idx" ON "workspace_branches"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_branches_projectId_name_key" ON "workspace_branches"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "share_tokens_tokenHash_key" ON "share_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "share_tokens_projectId_kind_idx" ON "share_tokens"("projectId", "kind");

-- CreateIndex
CREATE INDEX "agent_approval_requests_projectId_status_idx" ON "agent_approval_requests"("projectId", "status");

-- CreateIndex
CREATE INDEX "agent_approval_requests_apiKeyId_createdAt_idx" ON "agent_approval_requests"("apiKeyId", "createdAt");

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

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- CreateIndex
CREATE INDEX "plans_name_idx" ON "plans"("name");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_paddleSubscriptionId_key" ON "subscriptions"("paddleSubscriptionId");

-- CreateIndex
CREATE INDEX "subscriptions_userId_idx" ON "subscriptions"("userId");

-- CreateIndex
CREATE INDEX "subscriptions_planId_idx" ON "subscriptions"("planId");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_paddleSubscriptionId_idx" ON "subscriptions"("paddleSubscriptionId");

-- CreateIndex
CREATE INDEX "subscriptions_organizationId_idx" ON "subscriptions"("organizationId");

-- CreateIndex
CREATE INDEX "webhooks_projectId_idx" ON "webhooks"("projectId");

-- CreateIndex
CREATE INDEX "webhooks_eventType_idx" ON "webhooks"("eventType");

-- CreateIndex
CREATE INDEX "webhooks_active_idx" ON "webhooks"("active");

-- CreateIndex
CREATE INDEX "webhook_logs_webhookId_idx" ON "webhook_logs"("webhookId");

-- CreateIndex
CREATE INDEX "webhook_logs_status_idx" ON "webhook_logs"("status");

-- CreateIndex
CREATE INDEX "webhook_logs_createdAt_idx" ON "webhook_logs"("createdAt");

-- CreateIndex
CREATE INDEX "webhook_logs_nextRetryAt_idx" ON "webhook_logs"("nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "custom_domains_domain_key" ON "custom_domains"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "custom_domains_verificationToken_key" ON "custom_domains"("verificationToken");

-- CreateIndex
CREATE INDEX "custom_domains_projectId_idx" ON "custom_domains"("projectId");

-- CreateIndex
CREATE INDEX "custom_domains_domain_idx" ON "custom_domains"("domain");

-- CreateIndex
CREATE INDEX "custom_domains_verified_idx" ON "custom_domains"("verified");

-- CreateIndex
CREATE INDEX "custom_domains_active_idx" ON "custom_domains"("active");

-- CreateIndex
CREATE INDEX "connected_apps_projectId_isActive_idx" ON "connected_apps"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "connected_apps_projectId_origin_key" ON "connected_apps"("projectId", "origin");

-- CreateIndex
CREATE INDEX "project_env_vars_projectId_idx" ON "project_env_vars"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_env_vars_projectId_key_key" ON "project_env_vars"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_messageSeq_key" ON "conversation_messages"("messageSeq");

-- CreateIndex
CREATE INDEX "conversation_messages_projectId_idx" ON "conversation_messages"("projectId");

-- CreateIndex
CREATE INDEX "conversation_messages_createdAt_idx" ON "conversation_messages"("createdAt");

-- CreateIndex
CREATE INDEX "conversation_messages_projectId_createdAt_idx" ON "conversation_messages"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_messages_projectId_messageSeq_idx" ON "conversation_messages"("projectId", "messageSeq");

-- CreateIndex
CREATE INDEX "chat_runs_projectId_status_idx" ON "chat_runs"("projectId", "status");

-- CreateIndex
CREATE INDEX "chat_runs_projectId_startedAt_idx" ON "chat_runs"("projectId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "chat_runs_projectId_requestId_key" ON "chat_runs"("projectId", "requestId");

-- CreateIndex
CREATE INDEX "chat_run_events_runId_seq_idx" ON "chat_run_events"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "chat_run_events_runId_seq_key" ON "chat_run_events"("runId", "seq");

-- CreateIndex
CREATE INDEX "app_triggers_projectId_idx" ON "app_triggers"("projectId");

-- CreateIndex
CREATE INDEX "app_triggers_sourceTable_idx" ON "app_triggers"("sourceTable");

-- CreateIndex
CREATE INDEX "app_triggers_event_idx" ON "app_triggers"("event");

-- CreateIndex
CREATE INDEX "app_triggers_enabled_idx" ON "app_triggers"("enabled");

-- CreateIndex
CREATE INDEX "permission_policies_projectId_idx" ON "permission_policies"("projectId");

-- CreateIndex
CREATE INDEX "permission_policies_tableName_idx" ON "permission_policies"("tableName");

-- CreateIndex
CREATE UNIQUE INDEX "permission_policies_projectId_tableName_policyName_key" ON "permission_policies"("projectId", "tableName", "policyName");

-- CreateIndex
CREATE INDEX "ai_functions_projectId_idx" ON "ai_functions"("projectId");

-- CreateIndex
CREATE INDEX "ai_functions_projectId_triggerType_idx" ON "ai_functions"("projectId", "triggerType");

-- CreateIndex
CREATE INDEX "ai_functions_projectId_status_idx" ON "ai_functions"("projectId", "status");

-- CreateIndex
CREATE INDEX "ai_function_logs_functionId_idx" ON "ai_function_logs"("functionId");

-- CreateIndex
CREATE INDEX "ai_function_logs_projectId_idx" ON "ai_function_logs"("projectId");

-- CreateIndex
CREATE INDEX "ai_function_logs_projectId_createdAt_idx" ON "ai_function_logs"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_backups_projectId_idx" ON "workspace_backups"("projectId");

-- CreateIndex
CREATE INDEX "workspace_backups_projectId_createdAt_idx" ON "workspace_backups"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_backups_status_idx" ON "workspace_backups"("status");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expiresAt_idx" ON "password_reset_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "platform_notifications_userId_idx" ON "platform_notifications"("userId");

-- CreateIndex
CREATE INDEX "platform_notifications_read_idx" ON "platform_notifications"("read");

-- CreateIndex
CREATE INDEX "platform_notifications_type_idx" ON "platform_notifications"("type");

-- CreateIndex
CREATE INDEX "platform_notifications_createdAt_idx" ON "platform_notifications"("createdAt");

-- CreateIndex
CREATE INDEX "platform_notifications_userId_read_idx" ON "platform_notifications"("userId", "read");

-- CreateIndex
CREATE INDEX "notification_preferences_userId_idx" ON "notification_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_type_key" ON "notification_preferences"("userId", "type");

-- CreateIndex
CREATE INDEX "autonomous_actions_projectId_idx" ON "autonomous_actions"("projectId");

-- CreateIndex
CREATE INDEX "autonomous_actions_projectId_seenByUser_idx" ON "autonomous_actions"("projectId", "seenByUser");

-- CreateIndex
CREATE INDEX "autonomous_actions_createdAt_idx" ON "autonomous_actions"("createdAt");

-- CreateIndex
CREATE INDEX "project_usage_projectId_idx" ON "project_usage"("projectId");

-- CreateIndex
CREATE INDEX "project_usage_month_idx" ON "project_usage"("month");

-- CreateIndex
CREATE UNIQUE INDEX "project_usage_projectId_month_key" ON "project_usage"("projectId", "month");

-- CreateIndex
CREATE INDEX "credit_bills_userId_idx" ON "credit_bills"("userId");

-- CreateIndex
CREATE INDEX "credit_bills_month_idx" ON "credit_bills"("month");

-- CreateIndex
CREATE INDEX "credit_bills_paid_idx" ON "credit_bills"("paid");

-- CreateIndex
CREATE UNIQUE INDEX "credit_bills_userId_month_key" ON "credit_bills"("userId", "month");

-- CreateIndex
CREATE INDEX "trigger_delivery_logs_triggerId_idx" ON "trigger_delivery_logs"("triggerId");

-- CreateIndex
CREATE INDEX "trigger_delivery_logs_projectId_idx" ON "trigger_delivery_logs"("projectId");

-- CreateIndex
CREATE INDEX "trigger_delivery_logs_status_idx" ON "trigger_delivery_logs"("status");

-- CreateIndex
CREATE INDEX "trigger_delivery_logs_createdAt_idx" ON "trigger_delivery_logs"("createdAt");

-- CreateIndex
CREATE INDEX "product_events_userId_idx" ON "product_events"("userId");

-- CreateIndex
CREATE INDEX "product_events_projectId_idx" ON "product_events"("projectId");

-- CreateIndex
CREATE INDEX "product_events_eventType_idx" ON "product_events"("eventType");

-- CreateIndex
CREATE INDEX "product_events_timestamp_idx" ON "product_events"("timestamp");

-- CreateIndex
CREATE INDEX "usage_metrics_userId_idx" ON "usage_metrics"("userId");

-- CreateIndex
CREATE INDEX "usage_metrics_projectId_idx" ON "usage_metrics"("projectId");

-- CreateIndex
CREATE INDEX "usage_metrics_date_idx" ON "usage_metrics"("date");

-- CreateIndex
CREATE UNIQUE INDEX "agent_memories_fingerprint_key" ON "agent_memories"("fingerprint");

-- CreateIndex
CREATE INDEX "agent_memories_fingerprint_idx" ON "agent_memories"("fingerprint");

-- CreateIndex
CREATE INDEX "execution_logs_projectId_idx" ON "execution_logs"("projectId");

-- CreateIndex
CREATE INDEX "execution_logs_createdAt_idx" ON "execution_logs"("createdAt");

-- CreateIndex
CREATE INDEX "execution_logs_intent_idx" ON "execution_logs"("intent");

-- CreateIndex
CREATE INDEX "execution_logs_success_idx" ON "execution_logs"("success");

-- CreateIndex
CREATE INDEX "project_preferences_projectId_idx" ON "project_preferences"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_preferences_projectId_type_key_key" ON "project_preferences"("projectId", "type", "key");

-- CreateIndex
CREATE INDEX "project_rejection_patterns_projectId_idx" ON "project_rejection_patterns"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_rejection_patterns_projectId_pattern_key" ON "project_rejection_patterns"("projectId", "pattern");

-- CreateIndex
CREATE INDEX "execution_cancellations_projectId_idx" ON "execution_cancellations"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "execution_cancellations_projectId_convId_key" ON "execution_cancellations"("projectId", "convId");

-- CreateIndex
CREATE INDEX "execution_timeline_entries_projectId_executionId_idx" ON "execution_timeline_entries"("projectId", "executionId");

-- CreateIndex
CREATE INDEX "execution_timeline_entries_projectId_startedAt_idx" ON "execution_timeline_entries"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "execution_timeline_entries_status_idx" ON "execution_timeline_entries"("status");

-- CreateIndex
CREATE INDEX "execution_timeline_entries_errorClassification_idx" ON "execution_timeline_entries"("errorClassification");

-- CreateIndex
CREATE INDEX "correction_events_projectId_idx" ON "correction_events"("projectId");

-- CreateIndex
CREATE INDEX "correction_events_correctionType_idx" ON "correction_events"("correctionType");

-- CreateIndex
CREATE INDEX "correction_events_domain_originalActionType_idx" ON "correction_events"("domain", "originalActionType");

-- CreateIndex
CREATE INDEX "correction_events_errorClassification_idx" ON "correction_events"("errorClassification");

-- CreateIndex
CREATE INDEX "correction_events_createdAt_idx" ON "correction_events"("createdAt");

-- CreateIndex
CREATE INDEX "correction_patterns_status_idx" ON "correction_patterns"("status");

-- CreateIndex
CREATE INDEX "correction_patterns_domain_actionType_idx" ON "correction_patterns"("domain", "actionType");

-- CreateIndex
CREATE UNIQUE INDEX "correction_patterns_domain_actionType_errorClassification_key" ON "correction_patterns"("domain", "actionType", "errorClassification");

-- CreateIndex
CREATE INDEX "background_jobs_status_runAt_idx" ON "background_jobs"("status", "runAt");

-- CreateIndex
CREATE INDEX "background_jobs_projectId_idx" ON "background_jobs"("projectId");

-- CreateIndex
CREATE INDEX "background_jobs_type_status_idx" ON "background_jobs"("type", "status");

-- CreateIndex
CREATE INDEX "background_jobs_timeoutAt_idx" ON "background_jobs"("timeoutAt");

-- CreateIndex
CREATE INDEX "schema_versions_projectId_idx" ON "schema_versions"("projectId");

-- CreateIndex
CREATE INDEX "schema_versions_projectId_versionNum_idx" ON "schema_versions"("projectId", "versionNum");

-- CreateIndex
CREATE INDEX "health_findings_projectId_status_idx" ON "health_findings"("projectId", "status");

-- CreateIndex
CREATE INDEX "health_findings_projectId_severity_idx" ON "health_findings"("projectId", "severity");

-- CreateIndex
CREATE INDEX "health_findings_projectId_category_idx" ON "health_findings"("projectId", "category");

-- CreateIndex
CREATE INDEX "health_findings_projectId_detectedAt_idx" ON "health_findings"("projectId", "detectedAt");

-- CreateIndex
CREATE INDEX "health_findings_type_idx" ON "health_findings"("type");

-- CreateIndex
CREATE INDEX "workspace_schema_snapshots_projectId_idx" ON "workspace_schema_snapshots"("projectId");

-- CreateIndex
CREATE INDEX "workspace_schema_snapshots_projectId_versionNum_idx" ON "workspace_schema_snapshots"("projectId", "versionNum");

-- CreateIndex
CREATE INDEX "workspace_schema_snapshots_projectId_createdAt_idx" ON "workspace_schema_snapshots"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "pending_workflows_projectId_status_idx" ON "pending_workflows"("projectId", "status");

-- CreateIndex
CREATE INDEX "pending_workflows_projectId_type_idx" ON "pending_workflows"("projectId", "type");

-- CreateIndex
CREATE INDEX "pending_workflows_expiresAt_idx" ON "pending_workflows"("expiresAt");

-- CreateIndex
CREATE INDEX "blocklist_kind_idx" ON "blocklist"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "blocklist_kind_value_key" ON "blocklist"("kind", "value");

-- CreateIndex
CREATE INDEX "security_events_kind_idx" ON "security_events"("kind");

-- CreateIndex
CREATE INDEX "security_events_severity_idx" ON "security_events"("severity");

-- CreateIndex
CREATE INDEX "security_events_userId_idx" ON "security_events"("userId");

-- CreateIndex
CREATE INDEX "security_events_projectId_idx" ON "security_events"("projectId");

-- CreateIndex
CREATE INDEX "security_events_resolved_idx" ON "security_events"("resolved");

-- CreateIndex
CREATE INDEX "security_events_createdAt_idx" ON "security_events"("createdAt");

-- CreateIndex
CREATE INDEX "unsupported_requests_category_idx" ON "unsupported_requests"("category");

-- CreateIndex
CREATE INDEX "unsupported_requests_userId_idx" ON "unsupported_requests"("userId");

-- CreateIndex
CREATE INDEX "unsupported_requests_createdAt_idx" ON "unsupported_requests"("createdAt");

-- CreateIndex
CREATE INDEX "support_tickets_userId_idx" ON "support_tickets"("userId");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- CreateIndex
CREATE INDEX "support_tickets_createdAt_idx" ON "support_tickets"("createdAt");

-- CreateIndex
CREATE INDEX "feature_requests_userId_idx" ON "feature_requests"("userId");

-- CreateIndex
CREATE INDEX "feature_requests_status_idx" ON "feature_requests"("status");

-- CreateIndex
CREATE INDEX "feature_requests_createdAt_idx" ON "feature_requests"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "project_auth_configs_projectId_key" ON "project_auth_configs"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "database_credentials_roleName_key" ON "database_credentials"("roleName");

-- CreateIndex
CREATE INDEX "database_credentials_projectId_idx" ON "database_credentials"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "database_credentials_projectId_mode_key" ON "database_credentials"("projectId", "mode");

-- CreateIndex
CREATE INDEX "schema_drift_events_projectId_status_idx" ON "schema_drift_events"("projectId", "status");

-- CreateIndex
CREATE INDEX "schema_drift_events_capturedAt_idx" ON "schema_drift_events"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_clients_clientId_key" ON "mcp_oauth_clients"("clientId");

-- CreateIndex
CREATE INDEX "mcp_oauth_clients_createdAt_idx" ON "mcp_oauth_clients"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_codes_codeHash_key" ON "mcp_oauth_codes"("codeHash");

-- CreateIndex
CREATE INDEX "mcp_oauth_codes_expiresAt_idx" ON "mcp_oauth_codes"("expiresAt");

-- CreateIndex
CREATE INDEX "mcp_oauth_codes_apiKeyId_idx" ON "mcp_oauth_codes"("apiKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_refresh_tokens_tokenHash_key" ON "mcp_oauth_refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "mcp_oauth_refresh_tokens_apiKeyId_idx" ON "mcp_oauth_refresh_tokens"("apiKeyId");

-- CreateIndex
CREATE INDEX "mcp_oauth_refresh_tokens_expiresAt_idx" ON "mcp_oauth_refresh_tokens"("expiresAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_activeGraphId_fkey" FOREIGN KEY ("activeGraphId") REFERENCES "backend_graphs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_integration_keys" ADD CONSTRAINT "project_integration_keys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegated_connections" ADD CONSTRAINT "delegated_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation_audit_logs" ADD CONSTRAINT "delegation_audit_logs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "delegated_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_metadata" ADD CONSTRAINT "project_metadata_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intent_logs" ADD CONSTRAINT "intent_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "db_baseline_samples" ADD CONSTRAINT "db_baseline_samples_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schema_intents" ADD CONSTRAINT "schema_intents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backend_events" ADD CONSTRAINT "backend_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backend_events" ADD CONSTRAINT "backend_events_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "change_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_receipts" ADD CONSTRAINT "change_receipts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backend_graphs" ADD CONSTRAINT "backend_graphs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backend_graphs" ADD CONSTRAINT "backend_graphs_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "backend_graphs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_backup_codes" ADD CONSTRAINT "two_factor_backup_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_files" ADD CONSTRAINT "workspace_files_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_issues" ADD CONSTRAINT "database_issues_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_oauth_configs" ADD CONSTRAINT "workspace_oauth_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "workspace_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_usage" ADD CONSTRAINT "api_key_usage_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_acknowledgedBy_fkey" FOREIGN KEY ("acknowledgedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs" ADD CONSTRAINT "logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_issues" ADD CONSTRAINT "security_issues_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_attacks" ADD CONSTRAINT "blocked_attacks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_scans" ADD CONSTRAINT "security_scans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_buckets" ADD CONSTRAINT "storage_buckets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_files" ADD CONSTRAINT "storage_files_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "storage_buckets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_files" ADD CONSTRAINT "storage_files_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multipart_uploads" ADD CONSTRAINT "multipart_uploads_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "storage_buckets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multipart_uploads" ADD CONSTRAINT "multipart_uploads_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_configurations" ADD CONSTRAINT "ai_configurations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_ai_usage" ADD CONSTRAINT "user_ai_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_active_users" ADD CONSTRAINT "project_active_users_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_grants" ADD CONSTRAINT "referral_grants_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_grants" ADD CONSTRAINT "referral_grants_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_providerCredentialId_fkey" FOREIGN KEY ("providerCredentialId") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentAudit" ADD CONSTRAINT "DeploymentAudit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy_confirmations" ADD CONSTRAINT "deploy_confirmations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_definitions" ADD CONSTRAINT "api_definitions_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_usage_logs" ADD CONSTRAINT "api_usage_logs_apiDefinitionId_fkey" FOREIGN KEY ("apiDefinitionId") REFERENCES "api_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paddle_subscriptions" ADD CONSTRAINT "paddle_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_branches" ADD CONSTRAINT "workspace_branches_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_apps" ADD CONSTRAINT "connected_apps_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_env_vars" ADD CONSTRAINT "project_env_vars_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_run_events" ADD CONSTRAINT "chat_run_events_runId_fkey" FOREIGN KEY ("runId") REFERENCES "chat_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_triggers" ADD CONSTRAINT "app_triggers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_policies" ADD CONSTRAINT "permission_policies_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_functions" ADD CONSTRAINT "ai_functions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_function_logs" ADD CONSTRAINT "ai_function_logs_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "ai_functions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_backups" ADD CONSTRAINT "workspace_backups_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_notifications" ADD CONSTRAINT "platform_notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autonomous_actions" ADD CONSTRAINT "autonomous_actions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_usage" ADD CONSTRAINT "project_usage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_delivery_logs" ADD CONSTRAINT "trigger_delivery_logs_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "app_triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_preferences" ADD CONSTRAINT "project_preferences_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_rejection_patterns" ADD CONSTRAINT "project_rejection_patterns_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_cancellations" ADD CONSTRAINT "execution_cancellations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_timeline_entries" ADD CONSTRAINT "execution_timeline_entries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_events" ADD CONSTRAINT "correction_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_findings" ADD CONSTRAINT "health_findings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_requests" ADD CONSTRAINT "feature_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_auth_configs" ADD CONSTRAINT "project_auth_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "mcp_oauth_clients"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_refresh_tokens" ADD CONSTRAINT "mcp_oauth_refresh_tokens_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "mcp_oauth_clients"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_refresh_tokens" ADD CONSTRAINT "mcp_oauth_refresh_tokens_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

