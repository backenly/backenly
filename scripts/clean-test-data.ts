import { prisma } from '../lib/db'

const projectId = '97b41065-04dd-4283-8885-ed0b1794aee1'
const schema = `workspace_97b41065-04dd-4283-8885-ed0b1794aee1`

async function cleanTestData() {
  console.log('🧹 Cleaning test data...\n')
  
  try {
    // 1. Delete all API definitions
    const apis = await prisma.apiDefinition.deleteMany({
      where: { projectId }
    })
    console.log(`✅ Deleted ${apis.count} API definitions`)
    
    // 2. Get all tables
    const tables = await prisma.table.findMany({
      where: { projectId },
      select: { name: true }
    })
    
    console.log(`\n📊 Found ${tables.length} tables to drop:`)
    
    // 4. Drop all tables from workspace schema
    for (const table of tables) {
      try {
        await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schema}"."${table.name}" CASCADE`)
        console.log(`  ✅ Dropped table: ${table.name}`)
      } catch (error: any) {
        console.log(`  ⚠️  Could not drop ${table.name}: ${error.message}`)
      }
    }
    
    // 5. Delete table records from metadata
    const deletedTables = await prisma.table.deleteMany({
      where: { projectId }
    })
    console.log(`\n✅ Deleted ${deletedTables.count} table metadata records`)
    
    console.log('\n✨ Database cleaned successfully!')
    console.log('Ready for fresh eval run.')
    
  } catch (error: any) {
    console.error('❌ Error cleaning data:', error.message)
    throw error
  }
}

cleanTestData()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
