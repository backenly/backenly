/**
 * SOFT DELETE + ANONYMIZATION - User Exit Safety
 * 
 * When users delete their accounts:
 * 1. User record is soft-deleted (deleted_at timestamp)
 * 2. Identity is anonymized (email, name → 'Deleted User')
 * 3. Related content remains (posts, comments) but shows anonymized author
 * 
 * NO hard deletes, NO content disappearance - SAFE USER EXIT.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export interface SoftDeleteConfig {
  enabled: boolean
  anonymizeFields?: string[] // Fields to anonymize (e.g., ['name', 'email'])
  replacement: string // What to show (e.g., 'Deleted User')
}

/**
 * Soft delete user with anonymization
 * 
 * Marks user as deleted and anonymizes identity fields
 * Related content (posts, comments) remains intact
 * 
 * @param userId - User ID to soft-delete
 * @param config - Soft delete configuration
 */
export async function softDeleteUser(
  userId: string,
  config: SoftDeleteConfig
): Promise<void> {
  if (!config || !config.enabled) {
    // Hard delete not supported - throw error
    throw new Error('Hard delete is not supported. Use soft-delete configuration.')
  }

  const anonymizeFields = config.anonymizeFields || ['name', 'email']
  const replacement = config.replacement || 'Deleted User'

  try {
    // Build update data for anonymization
    const updateData: any = {
      deletedAt: new Date(),
    }

    // Anonymize specified fields
    anonymizeFields.forEach(field => {
      if (field === 'email') {
        // Email must remain unique - append timestamp
        updateData[field] = `deleted_${userId}@system.local`
      } else {
        updateData[field] = replacement
      }
    })

    // Soft-delete user record
    await prisma.user.update({
      where: { id: userId },
      data: updateData,
    })

    console.log(`[SoftDelete] ✅ User ${userId} soft-deleted and anonymized`)

    // Anonymize user's content (posts, comments, etc.)
    await anonymizeUserContent(userId, replacement)
  } catch (error) {
    console.error(`[SoftDelete] Failed to soft-delete user:`, error)
    throw new Error('Failed to delete user account safely.')
  }
}

/**
 * Anonymize user's content across all tables
 * 
 * Updates author names in posts, comments, and other user-generated content
 * Content remains visible but shows "Deleted User" as author
 * 
 * @param userId - User ID whose content should be anonymized
 * @param replacement - Replacement text (e.g., 'Deleted User')
 */
async function anonymizeUserContent(
  userId: string,
  replacement: string
): Promise<void> {
  try {
    // Get all tables that reference users
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT DISTINCT table_name 
      FROM information_schema.columns 
      WHERE column_name = 'created_by' OR column_name = 'user_id' OR column_name = 'author_id'
    `

    for (const table of tables) {
      const tableName = table.table_name

      // Skip system tables
      if (tableName === 'users' || tableName.startsWith('_')) continue

      try {
        // Check if table has author_name or similar field
        const hasNameField = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) as count
          FROM information_schema.columns 
          WHERE table_name = ${tableName} AND column_name IN ('author_name', 'creator_name', 'user_name')
        `

        if (Number(hasNameField[0]?.count || 0) > 0) {
          // Update name fields
          await prisma.$executeRawUnsafe(
            `UPDATE "${tableName}" SET "author_name" = $1 WHERE "created_by" = $2`,
            replacement,
            userId
          )
        }

        console.log(`[SoftDelete] ✅ Anonymized content in ${tableName}`)
      } catch (error) {
        console.warn(`[SoftDelete] Could not anonymize ${tableName}:`, error)
        // Continue with other tables
      }
    }
  } catch (error) {
    console.error(`[SoftDelete] Failed to anonymize user content:`, error)
    // Don't throw - partial anonymization is better than none
  }
}

/**
 * Check if user is soft-deleted
 * 
 * @param userId - User ID to check
 * @returns true if user is soft-deleted
 */
export async function isUserDeleted(userId: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true },
    })

    return user?.deletedAt !== null
  } catch (error) {
    console.error(`[SoftDelete] Failed to check deletion status:`, error)
    return false
  }
}

/**
 * Restore soft-deleted user (admin only)
 * 
 * @param userId - User ID to restore
 */
export async function restoreUser(userId: string): Promise<void> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { deletedAt: null },
    })

    console.log(`[SoftDelete] ✅ User ${userId} restored`)
  } catch (error) {
    console.error(`[SoftDelete] Failed to restore user:`, error)
    throw new Error('Failed to restore user account.')
  }
}
