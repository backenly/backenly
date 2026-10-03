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

    CONSTRAINT "project_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_metadata_projectId_key" ON "project_metadata"("projectId");

-- CreateIndex
CREATE INDEX "project_metadata_projectId_idx" ON "project_metadata"("projectId");

-- AddForeignKey
ALTER TABLE "project_metadata" ADD CONSTRAINT "project_metadata_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
