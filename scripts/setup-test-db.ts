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
  console.error('To fix this:')
  console.error('1. Open your Neon console: https://console.neon.tech')
  console.error('2. Select your project and branch')
  console.error('3. Open SQL Editor and run: CREATE DATABASE backenly_test;')
  console.error('4. Add TEST_DATABASE_URL to your .env file:')
  console.error('   TEST_DATABASE_URL=postgresql://user:pass@host/backenly_test?sslmode=require')
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
