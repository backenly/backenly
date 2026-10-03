-- Add security fields to Project model for JWT secret persistence and auth manifest
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "jwtSecret" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "authManifest" JSONB;

-- Add tokenVersion for token revocation
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Add soft delete support
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- Add index for soft delete queries
CREATE INDEX IF NOT EXISTS "users_deletedAt_idx" ON "users"("deletedAt");

-- Add index for tokenVersion queries (for token validation)
CREATE INDEX IF NOT EXISTS "users_tokenVersion_idx" ON "users"("tokenVersion");
