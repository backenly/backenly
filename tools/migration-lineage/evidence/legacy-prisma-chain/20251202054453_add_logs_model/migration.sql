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

-- AddForeignKey
ALTER TABLE "logs" ADD CONSTRAINT "logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
