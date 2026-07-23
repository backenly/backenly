/**
 * 🔒 ENABLE POSTGRESQL ROW-LEVEL SECURITY
 * 
 * Run this script once to enable RLS on all tables
 * This makes data leakage PHYSICALLY IMPOSSIBLE at database level
 * 
 * Usage: npx ts-node scripts/enable-rls.ts
 */

import enableRowLevelSecurity, { testRLSEnforcement } from '../lib/db/rls'

async function main() {
  console.log('\n' + '='.repeat(60))
  console.log('🔒 POSTGRESQL ROW-LEVEL SECURITY SETUP')
  console.log('='.repeat(60) + '\n')

  console.log('This will enable RLS policies on all tenant-scoped tables.')
  console.log('Even if Prisma is bypassed, the database will enforce isolation.\n')

  try {
    // Enable RLS
    await enableRowLevelSecurity()

    // Run tests
    console.log('\n' + '='.repeat(60))
    await testRLSEnforcement()
    console.log('='.repeat(60) + '\n')

    console.log('✅ Row-Level Security is now active!')
    console.log('\n📚 Next steps:')
    console.log('  1. Use setProjectContext(projectId) before queries')
    console.log('  2. RLS will automatically filter all results')
    console.log('  3. Queries without context will return empty results\n')

    process.exit(0)
  } catch (error) {
    console.error('❌ Failed to enable RLS:', error)
    process.exit(1)
  }
}

main()
