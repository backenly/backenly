export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import crypto from 'crypto'
import { requireAdmin } from '@/lib/auth/middleware'

/**
 * ADMIN ONLY: Repair API Keys Missing Plaintext
 *
 * This endpoint regenerates plaintext keys for any API keys that have null values.
 * Used to fix production keys after migration.
 */
export async function POST(request: NextRequest) {
  try {
    // Admin-only guard (founder email or admin role required)
    const adminError = await requireAdmin(request)
    if (adminError) return adminError
    
    console.log('🔧 [Repair Keys] Starting API key repair...')
    
    // Find keys missing plaintext
    const keysToRepair = await prisma.apiKey.findMany({
      where: {
        OR: [
          { key: null },
          { key: '' }
        ]
      },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        projectId: true,
        userId: true,
      }
    })
    
    if (keysToRepair.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No keys need repair',
        repaired: 0,
      })
    }
    
    console.log(`🛠️ [Repair Keys] Found ${keysToRepair.length} keys to repair`)
    
    const repairedKeys: any[] = []
    
    for (const apiKey of keysToRepair) {
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
      
      repairedKeys.push({
        id: apiKey.id,
        name: apiKey.name,
        projectId: apiKey.projectId,
        newKeyPrefix: newFullKey.substring(0, 12),
      })
      
      console.log(`✅ [Repair Keys] Repaired: ${apiKey.name}`)
    }
    
    return NextResponse.json({
      success: true,
      message: `Repaired ${repairedKeys.length} API keys`,
      repaired: repairedKeys.length,
      keys: repairedKeys,
    }, { status: 200 })
    
  } catch (error: any) {
    console.error('❌ [Repair Keys] Error:', error)
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to repair keys',
    }, { status: 500 })
  }
}
