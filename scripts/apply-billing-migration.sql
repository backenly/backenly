-- Apply billing usage tracking migration

-- Add rowCount to Project table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS "rowCount" INTEGER DEFAULT 0;

-- Create UserAiUsage table for billing AI tracking
CREATE TABLE IF NOT EXISTS user_ai_usage (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    "userId" TEXT NOT NULL,
    date TEXT NOT NULL,
    "intentCount" INTEGER DEFAULT 0,
    "tokenCount" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT user_ai_usage_userId_date_key UNIQUE ("userId", date)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS user_ai_usage_userId_idx ON user_ai_usage("userId");
CREATE INDEX IF NOT EXISTS user_ai_usage_date_idx ON user_ai_usage(date);

-- Add foreign key constraint
ALTER TABLE user_ai_usage 
    ADD CONSTRAINT user_ai_usage_userId_fkey 
    FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
