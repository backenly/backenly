/**
 * USAGE TRACKING (#8)
 * 
 * Purpose: Enforcement mechanism, NOT analytics
 * 
 * System tracks, enforces limits, blocks immediately
 * Users NEVER see: charts, dashboards, graphs
 * 
 * Only visible output: "This action exceeded its limit."
 */

export interface UsageLimit {
  id: string
  entity: string
  action: 'create' | 'update' | 'delete' | 'read'
  limit: number                     // Max per time window
  window: 'hour' | 'day' | 'month'
  scope: 'per_user' | 'per_project' | 'global'
  blockMessage: string              // What users see when blocked
}

export interface UsageTrackingState {
  enabled: boolean
  
  // Defined limits
  limits: Record<string, UsageLimit>
  
  // Current usage (internal, never shown)
  _internal: {
    usage: Record<string, {
      entity: string
      action: string
      count: number
      window: string
      lastReset: Date
    }>
  }
  
  reason: string
}

/**
 * Track and enforce usage limit
 */
export async function enforceUsageLimit(
  projectId: string,
  userId: string,
  entity: string,
  action: string
): Promise<{ allowed: boolean; reason?: string }> {
  
  const limit = await getUsageLimit(projectId, entity, action)
  if (!limit) {
    return { allowed: true }  // No limit defined
  }
  
  const current = await getCurrentUsage(projectId, userId, entity, action, limit.window)
  
  if (current >= limit.limit) {
    console.log(`[Usage Limit] BLOCKED: ${entity}.${action} (${current}/${limit.limit})`)
    return {
      allowed: false,
      reason: limit.blockMessage
    }
  }
  
  // Increment usage
  await incrementUsage(projectId, userId, entity, action, limit.window)
  
  return { allowed: true }
}

// Placeholder functions
async function getUsageLimit(projectId: string, entity: string, action: string): Promise<UsageLimit | null> { return null }
async function getCurrentUsage(projectId: string, userId: string, entity: string, action: string, window: string): Promise<number> { return 0 }
async function incrementUsage(projectId: string, userId: string, entity: string, action: string, window: string) {}
