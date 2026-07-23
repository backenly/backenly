/**
 * Cleanup Script for Expired Delegation Tokens
 * 
 * Run this periodically (cron job) to clean up expired tokens
 * and log expiration events
 */

import { prisma } from '../lib/db/postgres'

async function cleanupExpiredTokens() {
  console.log('[Cleanup] Starting expired token cleanup...')
  
  try {
    // Find expired tokens that haven't been marked as revoked
    const expiredConnections = await prisma.delegatedConnection.findMany({
      where: {
        expiresAt: { lt: new Date() },
        revokedAt: null,
      },
    })
    
    console.log(`[Cleanup] Found ${expiredConnections.length} expired connections`)
    
    if (expiredConnections.length === 0) {
      console.log('[Cleanup] No expired connections to clean up')
      return
    }
    
    // Log expiration events for each connection
    for (const connection of expiredConnections) {
      await prisma.delegationAuditLog.create({
        data: {
          connectionId: connection.id,
          action: 'expired',
          endpoint: 'system/cleanup',
          metadata: {
            provider: connection.provider,
            projectId: connection.projectId,
            expiresAt: connection.expiresAt.toISOString(),
          },
        },
      })
    }
    
    // Mark all expired connections as revoked
    const result = await prisma.delegatedConnection.updateMany({
      where: {
        expiresAt: { lt: new Date() },
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    })
    
    console.log(`[Cleanup] Marked ${result.count} connections as expired`)
    console.log('[Cleanup] Cleanup completed successfully')
    
    return {
      success: true,
      expiredCount: result.count,
    }
  } catch (error) {
    console.error('[Cleanup] Error during cleanup:', error)
    throw error
  }
}

// Run if called directly
if (require.main === module) {
  cleanupExpiredTokens()
    .then(() => {
      console.log('[Cleanup] Script finished')
      process.exit(0)
    })
    .catch((error) => {
      console.error('[Cleanup] Script failed:', error)
      process.exit(1)
    })
}

export { cleanupExpiredTokens }
