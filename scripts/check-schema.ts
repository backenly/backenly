import { prisma } from '../lib/db'

const projectId = 'test-project'
const schema = `workspace_97b41065-04dd-4283-8885-ed0b1794aee1`

async function checkSchema() {
  // Check users table
  const usersColumns: any[] = await prisma.$queryRawUnsafe(`
    SELECT 
      column_name, 
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'users'
    ORDER BY ordinal_position
  `, schema)
  
  console.log('📊 Users table schema:')
  usersColumns.forEach(col => {
    const required = col.is_nullable === 'NO' && !col.column_default ? '⚠️ REQUIRED' : ''
    console.log(`  - ${col.column_name} (${col.data_type}) ${required}`)
  })
  
  // Check products table
  const productsColumns: any[] = await prisma.$queryRawUnsafe(`
    SELECT 
      column_name, 
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'products'
    ORDER BY ordinal_position
  `, schema)
  
  console.log('\n📊 Products table schema:')
  productsColumns.forEach(col => {
    const required = col.is_nullable === 'NO' && !col.column_default ? '⚠️ REQUIRED' : ''
    console.log(`  - ${col.column_name} (${col.data_type}) ${required}`)
  })
}

checkSchema()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
