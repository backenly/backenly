/**
 * READ ISOLATION - Automatic Privacy Filters
 * 
 * Automatically adds WHERE clauses to read operations for privacy-critical entities.
 * Ensures users can only see their own data without manual filter configuration.
 * 
 * NO trust in client queries - ALWAYS enforced at data layer.
 */

export interface ReadIsolationConfig {
  enabled: boolean
  field: string // Field to filter by (e.g., 'created_by', 'user_id')
  reason: string // Human explanation
}

/**
 * Apply read isolation filter to query
 * 
 * Automatically adds WHERE {field} = {userId} to prevent cross-user data leakage
 * 
 * @param query - Original Prisma query object
 * @param userId - Current user ID
 * @param isolation - Read isolation configuration
 * @returns Modified query with isolation filter
 */
export function applyReadIsolation<T extends Record<string, any>>(
  query: T,
  userId: string,
  isolation: ReadIsolationConfig
): T {
  if (!isolation || !isolation.enabled) {
    // No isolation required
    return query
  }

  const isolationField = isolation.field || 'created_by'

  // Add isolation filter to WHERE clause
  const modifiedQuery = {
    ...query,
    where: {
      ...((query.where as any) || {}),
      [isolationField]: userId,
    },
  }

  console.log(`[ReadIsolation] ✅ Applied isolation filter: ${isolationField} = ${userId}`)
  return modifiedQuery as T
}

/**
 * Check if read isolation should be applied
 * 
 * @param resource - Resource name
 * @param isolation - Read isolation config
 * @returns true if isolation should be enforced
 */
export function shouldIsolateRead(
  resource: string,
  isolation?: ReadIsolationConfig
): boolean {
  if (!isolation) return false
  return isolation.enabled
}
