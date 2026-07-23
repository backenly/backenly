const { Client } = require('pg')
require('dotenv').config()

const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

const sql = `
  CREATE TABLE IF NOT EXISTS project_integration_keys (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "projectId" TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    "integrationId" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "maskedKey" TEXT NOT NULL,
    "connectedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE("projectId", "integrationId")
  );
  CREATE INDEX IF NOT EXISTS project_integration_keys_project_id ON project_integration_keys("projectId");
`

client.connect()
  .then(() => client.query(sql))
  .then(() => { console.log('Table created successfully'); client.end() })
  .catch(e => { console.error('Error:', e.message); client.end(); process.exit(1) })
