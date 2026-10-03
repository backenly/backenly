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
    "projectId" TEXT,
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
    "projectId" TEXT,
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
    "projectId" TEXT,
    "metadata" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_scans_pkey" PRIMARY KEY ("id")
);

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

-- AddForeignKey
ALTER TABLE "security_issues" ADD CONSTRAINT "security_issues_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_attacks" ADD CONSTRAINT "blocked_attacks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_scans" ADD CONSTRAINT "security_scans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
