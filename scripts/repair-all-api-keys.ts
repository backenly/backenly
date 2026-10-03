import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import { plaintextForStorage } from '../lib/auth/api-key-plaintext'

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
          // The repaired secret is printed for the operator below and is not
          // stored. See lib/auth/api-key-plaintext.ts: nothing reads this
          // column, and a database dump must not hand over working keys.
          key: plaintextForStorage(),
          keyHash: newKeyHash
        }
      })

      console.log(`✅ Repaired key: ${apiKey.name} (ID: ${apiKey.id})`)
      // Printed in full, ONCE. Now that the column is not written, this output
      // is the only place the rotated secret exists; truncating it here would
      // silently lock the operator out of the key they just rotated.
      console.log(`   New Key (copy now, not recoverable): ${newFullKey}`)
    }

    console.log('\n✨ All keys repaired successfully!')
  } catch (error: any) {
    console.error('❌ Repair failed:', error.message)
  } finally {
    await prisma.$disconnect()
  }
}

repairKeys().catch(console.error)
