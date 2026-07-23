#!/usr/bin/env ts-node
/**
 * Startup Check Script
 * 
 * Run this before starting the server to validate:
 * - Environment variables
 * - Database connectivity
 * - Schema alignment
 * 
 * Usage: npx ts-node scripts/startup-check.ts
 * Or: npm run validate (add to package.json)
 */

import { runStartupValidation } from '../lib/db/startup-validation'

async function main() {
  try {
    await runStartupValidation()
    console.log('✅ Startup validation passed')
    process.exit(0)
  } catch (error) {
    console.error('❌ Startup validation failed:', error)
    process.exit(1)
  }
}

main()
