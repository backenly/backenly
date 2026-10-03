-- CreateTable
CREATE TABLE "storage_buckets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectId" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

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
    "projectId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_files_pkey" PRIMARY KEY ("id")
);

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

-- AddForeignKey
ALTER TABLE "storage_buckets" ADD CONSTRAINT "storage_buckets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_files" ADD CONSTRAINT "storage_files_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "storage_buckets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_files" ADD CONSTRAINT "storage_files_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
