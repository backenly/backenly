-- Phase 6: anonymized cross-project pattern learning.
-- No project_id / user_id column by design — aggregation across projects is
-- the anonymization mechanism.

CREATE TABLE "backend_patterns" (
    "id" TEXT NOT NULL,
    "project_type" TEXT NOT NULL,
    "pattern_type" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "pattern_summary" TEXT NOT NULL,
    "frequency" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "risk_score" TEXT NOT NULL DEFAULT 'low',
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backend_patterns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "backend_patterns_project_type_pattern_type_resource_type_key"
    ON "backend_patterns"("project_type", "pattern_type", "resource_type");

CREATE INDEX "backend_patterns_project_type_idx" ON "backend_patterns"("project_type");
CREATE INDEX "backend_patterns_pattern_type_idx" ON "backend_patterns"("pattern_type");
CREATE INDEX "backend_patterns_risk_score_idx" ON "backend_patterns"("risk_score");
