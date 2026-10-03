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

-- AddForeignKey
ALTER TABLE "api_definitions" ADD CONSTRAINT "api_definitions_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_usage_logs" ADD CONSTRAINT "api_usage_logs_apiDefinitionId_fkey" FOREIGN KEY ("apiDefinitionId") REFERENCES "api_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
