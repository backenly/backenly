import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'

const prisma = new PrismaClient()

async function repairKeys() {
  console.log('🔍 Starting Universal API Key Repair...\n')

  try {
    const keysToRepair = await prisma.apiKey.findMany({
      where: {
        OR: [
          { key: null },
          { key: '' }
        ]
      }
    })

    if (keysToRepair.length === 0) {
      console.log('✅ No keys need repair. All keys have plaintext available.')
      return
    }

    console.log(`🛠️ Found ${keysToRepair.length} keys missing plaintext. Regenerating...\n`)

    for (const apiKey of keysToRepair) {
      // Generate a new key with same prefix if possible, or use standard prefix
      const prefix = apiKey.keyPrefix || 'sk_live_'
      const randomBytes = crypto.randomBytes(32).toString('hex')
      const newFullKey = `${prefix}${randomBytes}`
      const newKeyHash = crypto.createHash('sha256').update(newFullKey).digest('hex')

      await prisma.apiKey.update({
        where: { id: apiKey.id },
        data: {
          key: newFullKey,
          keyHash: newKeyHash
        }
      })

      console.log(`✅ Repaired key: ${apiKey.name} (ID: ${apiKey.id})`)
      console.log(`   New Key: ${newFullKey.substring(0, 12)}...`)
    }

    console.log('\n✨ All keys repaired successfully!')
  } catch (error: any) {
    console.error('❌ Repair failed:', error.message)
  } finally {
    await prisma.$disconnect()
  }
}

repairKeys().catch(console.error)
