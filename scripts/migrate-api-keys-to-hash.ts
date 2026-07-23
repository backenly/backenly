/**
 * Migrate API Keys to Hashed Storage
 * 
 * This script:
 * 1. Finds all API keys with plaintext but no hash
 * 2. Generates hash from plaintext key
 * 3. Updates keyHash field
 * 4. Logs migration progress
 * 
 * Run once to migrate existing keys, then drop the `key` column.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'

const prisma = new PrismaClient()

function hashApiKey(key: string): string {
  return crypto
    .createHash('sha256')
    .update(key)
    .digest('hex')
}

async function migrateApiKeys() {
  console.log('Starting API key migration to hashed storage...\n')

  try {
    // Find all keys that have plaintext
    // @ts-ignore - keyHash field exists in DB but Prisma client needs regeneration
    const keysToMigrate = await prisma.apiKey.findMany({
      where: {},
      select: {
        id: true,
        key: true,
        keyPrefix: true,
        userId: true,
        projectId: true,
      }
    })

    if (keysToMigrate.length === 0) {
      console.log('No keys to migrate. All keys are already hashed.')
      return
    }

    console.log(`Found ${keysToMigrate.length} keys to migrate\n`)

    let successCount = 0
    let errorCount = 0

    for (const apiKey of keysToMigrate) {
      try {
        const keyHash = hashApiKey(apiKey.key!)
        
        // @ts-ignore - keyHash field exists in DB but Prisma client needs regeneration
        await prisma.apiKey.update({
          where: { id: apiKey.id },
          data: { keyHash }
        })

        console.log(`[OK] Migrated key: ${apiKey.keyPrefix}... (projectId: ${apiKey.projectId || 'none'})`)
        successCount++
      } catch (error: any) {
        console.error(`[ERROR] Failed to migrate key ${apiKey.id}:`, error.message)
        errorCount++
      }
    }

    console.log('\n=== Migration Complete ===')
    console.log(`Success: ${successCount}`)
    console.log(`Errors: ${errorCount}`)
    console.log(`Total: ${keysToMigrate.length}`)

    if (successCount === keysToMigrate.length) {
      console.log('\nAll keys successfully migrated to hashed storage!')
      console.log('\nNext steps:')
      console.log('1. Verify all API key authentication works')
      console.log('2. Run: npx prisma migrate dev --name remove_plaintext_key')
      console.log('3. Remove `key String @unique` from schema.prisma')
      console.log('4. Keep only `keyHash String @unique`')
    }

  } catch (error: any) {
    console.error('Migration failed:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

// Run migration
migrateApiKeys()
  .catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
