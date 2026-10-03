-- Automatic API Versioning Tables
-- 
-- These tables store API version history for automatic, invisible versioning
-- that prevents instant breakage from schema mutations.

-- API Versions: Complete history of all API schemas
CREATE TABLE IF NOT EXISTS api_versions (
  version_id TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  endpoints JSONB NOT NULL, -- Array of ApiEndpointVersion
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL, -- Intent ID that triggered this version
  deprecated BOOLEAN NOT NULL DEFAULT FALSE,
  deprecated_at TIMESTAMP NULL,
  
  -- Indexes for efficient lookup
  UNIQUE (project_id, table_id, version_number),
  INDEX idx_api_versions_project (project_id),
  INDEX idx_api_versions_table (project_id, table_id),
  INDEX idx_api_versions_hash (project_id, table_id, schema_hash),
  INDEX idx_api_versions_active (project_id, table_id, deprecated)
);

-- Version Pinnings: Maps frontend connections to specific API versions
CREATE TABLE IF NOT EXISTS version_pinnings (
  connection_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  pinned_version_id TEXT NOT NULL REFERENCES api_versions(version_id),
  pinned_at TIMESTAMP NOT NULL DEFAULT NOW(),
  api_key_hash TEXT NULL,
  user_agent TEXT NULL,
  first_request_path TEXT NOT NULL,
  
  -- Indexes for efficient lookup
  INDEX idx_version_pinnings_project (project_id),
  INDEX idx_version_pinnings_version (pinned_version_id),
  INDEX idx_version_pinnings_api_key (api_key_hash)
);

-- Comments for documentation
COMMENT ON TABLE api_versions IS 'Stores complete history of API versions for automatic, invisible versioning';
COMMENT ON COLUMN api_versions.version_id IS 'Unique identifier: {tableId}_v{number}_{schemaHash}';
COMMENT ON COLUMN api_versions.schema_hash IS 'Hash of table schema (columns + relationships) for idempotency';
COMMENT ON COLUMN api_versions.endpoints IS 'Complete endpoint definitions with request/response shapes';
COMMENT ON COLUMN api_versions.deprecated IS 'TRUE if version rolled back via restore operation';

COMMENT ON TABLE version_pinnings IS 'Maps frontend connections to specific API versions (immutable pinning)';
COMMENT ON COLUMN version_pinnings.connection_id IS 'Unique per frontend connection (API key + client identifier)';
COMMENT ON COLUMN version_pinnings.pinned_at IS 'When connection was first established and pinned';
