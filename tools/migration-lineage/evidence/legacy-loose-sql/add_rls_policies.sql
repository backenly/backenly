-- PHASE 2: Row Level Security (RLS) Policies
-- Ensures data cannot leak across projects even with buggy queries

-- Enable RLS on all tenant-owned tables
ALTER TABLE "Table" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiDefinition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Deployment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DatabaseIssue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExecutionHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Log" ENABLE ROW LEVEL SECURITY;

-- Create RLS policies that enforce project_id isolation
-- Pattern: Only show rows where projectId matches current session

-- Table
DROP POLICY IF EXISTS "table_project_isolation" ON "Table";
CREATE POLICY "table_project_isolation" ON "Table"
  USING ("projectId" = current_setting('app.project_id', true)::text);

-- ApiDefinition
DROP POLICY IF EXISTS "api_definition_project_isolation" ON "ApiDefinition";
CREATE POLICY "api_definition_project_isolation" ON "ApiDefinition"
  USING ("projectId" = current_setting('app.project_id', true)::text);

-- ApiKey
DROP POLICY IF EXISTS "api_key_project_isolation" ON "ApiKey";
CREATE POLICY "api_key_project_isolation" ON "ApiKey"
  USING ("projectId" = current_setting('app.project_id', true)::text);

-- Deployment
DROP POLICY IF EXISTS "deployment_project_isolation" ON "Deployment";
CREATE POLICY "deployment_project_isolation" ON "Deployment"
  USING ("projectId" = current_setting('app.project_id', true)::text);

-- DatabaseIssue
DROP POLICY IF EXISTS "database_issue_project_isolation" ON "DatabaseIssue";
CREATE POLICY "database_issue_project_isolation" ON "DatabaseIssue"
  USING ("projectId" = current_setting('app.project_id', true)::text);

-- ExecutionHistory
DROP POLICY IF EXISTS "execution_history_project_isolation" ON "ExecutionHistory";
CREATE POLICY "execution_history_project_isolation" ON "ExecutionHistory"
  USING ("projectId" = current_setting('app.project_id', true)::text);

-- Workspace
DROP POLICY IF EXISTS "workspace_project_isolation" ON "Workspace";
CREATE POLICY "workspace_project_isolation" ON "Workspace"
  USING ("projectId" = current_setting('app.project_id', true)::text);

-- Log
DROP POLICY IF EXISTS "log_project_isolation" ON "Log";
CREATE POLICY "log_project_isolation" ON "Log"
  USING ("projectId" = current_setting('app.project_id', true)::text);

-- Verify RLS is enabled
DO $$
DECLARE
  tbl RECORD;
BEGIN
  FOR tbl IN 
    SELECT schemaname, tablename 
    FROM pg_tables 
    WHERE tablename IN ('Table', 'ApiDefinition', 'ApiKey', 'Deployment', 'DatabaseIssue', 'ExecutionHistory', 'Workspace', 'Log')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE c.relname = tbl.tablename AND c.relrowsecurity = true
    ) THEN
      RAISE EXCEPTION 'RLS not enabled on %.%', tbl.schemaname, tbl.tablename;
    END IF;
  END LOOP;
END $$;
