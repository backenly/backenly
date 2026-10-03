/**
 * Test Database Setup Script
 * 
 * This script helps set up the test database for running tests.
 * 
 * Usage:
 *   tsx scripts/setup-test-db.ts
 * 
 * Requirements:
 *   - TEST_DATABASE_URL must be set in .env
 *   - Database must exist on Neon (run CREATE DATABASE backenly_test; in Neon console)
 */

import { execSync } from 'child_process'
import { config } from 'dotenv'

// Load environment variables
config()

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

if (!TEST_DATABASE_URL) {
  console.error('❌ TEST_DATABASE_URL is not set')
  console.error('')
  console.error('It must point at a database of its own. The schema push below')
  console.error('runs with --accept-data-loss, so it must NOT equal DATABASE_URL.')
  console.error('')
  console.error('Local (docker-compose.dev.yml creates this database for you):')
  console.error('   TEST_DATABASE_URL=postgresql://backenly:changeme@localhost:5432/backenly_test')
  console.error('')
  console.error('Hosted (Neon): run CREATE DATABASE backenly_test; in the SQL')
  console.error('editor, then use that branch connection string:')
  console.error('   TEST_DATABASE_URL=postgresql://user:pass@host/backenly_test?sslmode=require')
  console.error('')
  console.error('Add it to .env — see .env.example.')
  console.error('')
  process.exit(1)
}

console.log('🔧 Setting up test database...')
console.log('Database URL:', TEST_DATABASE_URL.replace(/:[^:]*@/, ':***@'))
console.log('')

try {
  // Set DATABASE_URL to TEST_DATABASE_URL for Prisma
  process.env.DATABASE_URL = TEST_DATABASE_URL
  process.env.DIRECT_URL = TEST_DATABASE_URL
  
  console.log('📦 Pushing schema to test database...')
  
  execSync('npx prisma db push --accept-data-loss --skip-generate', {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_URL: TEST_DATABASE_URL
    }
  })
  
  // These two are the data source for every measurement-driven detector:
  // pg_stat_statements for measured slow queries and the hot-table index column,
  // pgstattuple for index bloat. Without them those tests have nothing to
  // measure and their assertions pass vacuously — which is how the hot-table
  // column test first shipped green while proving nothing.
  //
  // Non-fatal: pg_stat_statements needs `shared_preload_libraries` and a server
  // restart, so it cannot be created on a database that was not started with it.
  // (pgstattuple needs neither.) The tests that depend on them assert their
  // presence themselves and fail loudly, which is the right place for that to
  // surface.
  console.log('📊 Enabling pg_stat_statements + pgstattuple (the measurement probes)...')
  try {
    // `prisma db execute` rather than a pg client: this file runs under tsx's
    // CommonJS transform, which has no top-level await, and the surrounding
    // block is already synchronous execSync.
    execSync('npx prisma db execute --stdin --schema prisma/schema.prisma', {
      input: [
        'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;',
        'CREATE EXTENSION IF NOT EXISTS pgstattuple;',
      ].join('\n'),
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DIRECT_URL: TEST_DATABASE_URL },
    })
    console.log('   enabled')
  } catch (err: any) {
    console.warn(`   skipped: ${String(err?.stderr ?? err?.message ?? err).trim().split('\n').pop()}`)
    console.warn("   add shared_preload_libraries = 'pg_stat_statements' to postgresql.conf and restart")
  }

  console.log('')
  console.log('✅ Test database setup complete!')
  console.log('')
  console.log('You can now run tests with:')
  console.log('  npm test')
  console.log('')

} catch (error) {
  console.error('')
  console.error('❌ Failed to setup test database')
  console.error('')
  console.error('Common causes:')
  console.error('1. Database does not exist - Run CREATE DATABASE backenly_test; in Neon SQL Editor')
  console.error('2. Connection string is incorrect')
  console.error('3. Network connectivity issues')
  console.error('')
  process.exit(1)
}
