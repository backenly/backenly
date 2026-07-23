/**
 * OWNERSHIP ENFORCEMENT - Write Protection
 * 
 * Ensures users can only edit/delete their own resources.
 * Blocks unauthorized modifications at execution time.
 * 
 * NO trust in client, NO UI-based protection - HARD BLOCKING ONLY.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export interface OwnershipConfig {
  enabled: boolean
  field: string // Field name for owner (e.g., 'created_by', 'user_id')
  writeProtection: boolean // Only owner can edit/delete
}

export class OwnershipViolationError extends Error {
  constructor(
    public message: string,
    public userId: string,
    public resourceId: string,
    public resource: string
  ) {
    super(message)
    this.name = 'OwnershipViolationError'
  }
}

/**
 * Enforce ownership on write operations
 * 
 * @param userId - Current user ID
 * @param resourceId - Resource ID being modified
 * @param resource - Resource name (e.g., 'posts', 'comments')
 * @param ownership - Ownership configuration
 * @returns void if allowed, throws OwnershipViolationError if blocked
 */
export async function requireOwnership(
  userId: string,
  resourceId: string,
  resource: string,
  ownership: OwnershipConfig
): Promise<void> {
  if (!ownership || !ownership.enabled) {
    // Ownership not enforced - allow
    return
  }

  if (!ownership.writeProtection) {
    // Write protection disabled - allow
    return
  }

  const tableName = resource.toLowerCase()
  const ownerField = ownership.field || 'created_by'

  try {
    // SECURITY: Use parameterized query to prevent SQL injection
    const result = await prisma.$queryRawUnsafe<Array<{ [key: string]: any }>>(
      `SELECT "${ownerField}" FROM "${tableName}" WHERE "id" = $1`,
      resourceId
    )

    if (!result || result.length === 0) {
      throw new Error(`Resource not found: ${resource}#${resourceId}`)
    }

    const ownerId = result[0][ownerField]

    if (ownerId !== userId) {
      throw new OwnershipViolationError(
        `You can only modify your own ${resource}.`,
        userId,
        resourceId,
        resource
      )
    }

    // Ownership check passed
    console.log(`[OwnershipEnforcement] ✅ Ownership verified for ${userId} on ${resource}#${resourceId}`)
  } catch (error) {
    if (error instanceof OwnershipViolationError) {
      throw error
    }
    console.error(`[OwnershipEnforcement] Failed to verify ownership:`, error)
    // If check fails, block (fail-closed for security)
    throw new OwnershipViolationError(
      `Unable to verify ownership of ${resource}.`,
      userId,
      resourceId,
      resource
    )
  }
}

/**
 * Check if user owns a resource (non-throwing)
 * 
 * @param userId - Current user ID
 * @param resourceId - Resource ID
 * @param resource - Resource name
 * @param ownership - Ownership configuration
 * @returns true if user owns resource, false otherwise
 */
export async function checkOwnership(
  userId: string,
  resourceId: string,
  resource: string,
  ownership: OwnershipConfig
): Promise<boolean> {
  if (!ownership || !ownership.enabled) {
    return true // No ownership check - assume allowed
  }

  const tableName = resource.toLowerCase()
  const ownerField = ownership.field || 'created_by'

  try {
    const result = await prisma.$queryRawUnsafe<Array<{ [key: string]: any }>>(
      `SELECT "${ownerField}" FROM "${tableName}" WHERE "id" = $1`,
      resourceId
    )

    if (!result || result.length === 0) {
      return false
    }

    return result[0][ownerField] === userId
  } catch (error) {
    console.error(`[OwnershipEnforcement] Failed to check ownership:`, error)
    return false
  }
}
