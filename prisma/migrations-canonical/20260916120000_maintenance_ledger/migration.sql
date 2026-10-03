-- CreateTable
CREATE TABLE "maintenance_executions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "catalogFingerprint" TEXT NOT NULL,
    "approvalId" TEXT,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "haltReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_step_executions" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "stepKind" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "backgroundJobId" TEXT,
    "preconditionEvidence" JSONB,
    "postconditionEvidence" JSONB,
    "rollback" JSONB,
    "result" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_step_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "maintenance_executions_projectId_status_idx" ON "maintenance_executions"("projectId", "status");

-- CreateIndex
CREATE INDEX "maintenance_executions_findingId_idx" ON "maintenance_executions"("findingId");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_executions_planId_planVersion_key" ON "maintenance_executions"("planId", "planVersion");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_step_executions_idempotencyKey_key" ON "maintenance_step_executions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "maintenance_step_executions_executionId_ordinal_idx" ON "maintenance_step_executions"("executionId", "ordinal");

-- CreateIndex
CREATE INDEX "maintenance_step_executions_status_idx" ON "maintenance_step_executions"("status");

-- CreateIndex
CREATE INDEX "maintenance_step_executions_backgroundJobId_idx" ON "maintenance_step_executions"("backgroundJobId");

-- AddForeignKey
ALTER TABLE "maintenance_step_executions" ADD CONSTRAINT "maintenance_step_executions_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "maintenance_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

