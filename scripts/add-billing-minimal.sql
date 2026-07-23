-- Minimal billing schema - only essential tables
-- Run this after cleaning up space

-- Create SubscriptionStatus enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubscriptionStatus') THEN
        CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'FREE', 'GRACE', 'CANCELED', 'PAST_DUE');
    END IF;
END$$;

-- Create plans table
CREATE TABLE IF NOT EXISTS "plans" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    "name" TEXT UNIQUE NOT NULL,
    "priceCents" INTEGER DEFAULT 0,
    "maxProjects" INTEGER,
    "maxRowsPerProject" INTEGER,
    "allowedAuthProviders" TEXT[] DEFAULT ARRAY['google'],
    "apiRateLimitPerMin" INTEGER DEFAULT 60,
    "maxAiIntentsPerDay" INTEGER,
    "logRetentionDays" INTEGER DEFAULT 7,
    "allowWebhooks" BOOLEAN DEFAULT false,
    "allowCustomDomain" BOOLEAN DEFAULT false,
    "prioritySupport" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create subscriptions table
CREATE TABLE IF NOT EXISTS "subscriptions" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "planId" TEXT NOT NULL REFERENCES "plans"("id"),
    "paddleSubscriptionId" TEXT UNIQUE,
    "status" "SubscriptionStatus" DEFAULT 'FREE',
    "currentPeriodEnd" TIMESTAMP,
    "graceUntil" TIMESTAMP,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS "plans_name_idx" ON "plans"("name");
CREATE INDEX IF NOT EXISTS "subscriptions_userId_idx" ON "subscriptions"("userId");
CREATE INDEX IF NOT EXISTS "subscriptions_planId_idx" ON "subscriptions"("planId");
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions"("status");

-- Insert FREE plan
INSERT INTO "plans" ("id", "name", "priceCents", "maxProjects", "maxRowsPerProject", "allowedAuthProviders", "apiRateLimitPerMin", "maxAiIntentsPerDay", "logRetentionDays", "allowWebhooks", "allowCustomDomain", "prioritySupport")
VALUES (gen_random_uuid()::TEXT, 'FREE', 0, 1, 5000, ARRAY['google'], 60, 10, 7, false, false, false)
ON CONFLICT ("name") DO NOTHING;

-- Insert HOBBY plan
INSERT INTO "plans" ("id", "name", "priceCents", "maxProjects", "maxRowsPerProject", "allowedAuthProviders", "apiRateLimitPerMin", "maxAiIntentsPerDay", "logRetentionDays", "allowWebhooks", "allowCustomDomain", "prioritySupport")
VALUES (gen_random_uuid()::TEXT, 'HOBBY', 2900, 3, 100000, ARRAY['email', 'google', 'github'], 200, 100, 30, false, false, false)
ON CONFLICT ("name") DO NOTHING;

-- Insert PRO plan
INSERT INTO "plans" ("id", "name", "priceCents", "maxProjects", "maxRowsPerProject", "allowedAuthProviders", "apiRateLimitPerMin", "maxAiIntentsPerDay", "logRetentionDays", "allowWebhooks", "allowCustomDomain", "prioritySupport")
VALUES (gen_random_uuid()::TEXT, 'PRO', 15900, null, 1000000, ARRAY['email', 'google', 'github'], 500, null, 90, true, true, true)
ON CONFLICT ("name") DO NOTHING;

-- Create FREE subscriptions for existing users without subscriptions
INSERT INTO "subscriptions" ("userId", "planId", "status")
SELECT 
    u."id",
    p."id",
    'FREE'::"SubscriptionStatus"
FROM "users" u
CROSS JOIN (SELECT "id" FROM "plans" WHERE "name" = 'FREE') p
WHERE NOT EXISTS (
    SELECT 1 FROM "subscriptions" s WHERE s."userId" = u."id"
);
