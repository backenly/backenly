/**
 * Silent Scaling & Usage Monitoring
 * 
 * Phase 12: Automatic scaling, soft limits, no hard failures.
 * 
 * PRINCIPLE: "Your app is getting more usage. Everything is still working."
 */

export interface UsageMetrics {
  apiCalls: number
  storage: number
  users: number
  bandwidth: number
}

export interface UsageLimits {
  softLimit: number
  hardLimit: number
  unit: string
}

export interface UsageAlert {
  type: 'growth' | 'approaching-limit' | 'optimization-suggestion'
  message: string
  severity: 'info' | 'warning'
  showToUser: boolean
}

/**
 * Check usage and return alerts (never hard fail)
 */
export function checkUsage(
  current: UsageMetrics,
  limits: Record<keyof UsageMetrics, UsageLimits>
): UsageAlert[] {
  const alerts: UsageAlert[] = []

  // API Calls
  const apiCallsPercent = (current.apiCalls / limits.apiCalls.softLimit) * 100
  
  if (apiCallsPercent >= 80 && apiCallsPercent < 100) {
    alerts.push({
      type: 'approaching-limit',
      message: 'Your app is getting more usage. Everything is still working.',
      severity: 'info',
      showToUser: true,
    })
  } else if (apiCallsPercent >= 100 && apiCallsPercent < 150) {
    alerts.push({
      type: 'growth',
      message: 'Your app usage is growing. We automatically scaled to handle it.',
      severity: 'info',
      showToUser: true,
    })
  } else if (apiCallsPercent >= 150) {
    // Suggest optimization but don't break
    alerts.push({
      type: 'optimization-suggestion',
      message: 'Your app is very active. Consider reviewing performance to reduce costs.',
      severity: 'warning',
      showToUser: true,
    })
  }

  // Storage
  const storagePercent = (current.storage / limits.storage.softLimit) * 100
  
  if (storagePercent >= 80) {
    alerts.push({
      type: 'approaching-limit',
      message: 'Storage is filling up. Everything still works, but consider cleaning old data.',
      severity: 'info',
      showToUser: true,
    })
  }

  // Users
  if (current.users > limits.users.softLimit) {
    alerts.push({
      type: 'growth',
      message: `You now have ${current.users.toLocaleString()} users. Your app is growing!`,
      severity: 'info',
      showToUser: true,
    })
  }

  return alerts
}

/**
 * Apply rate limiting with soft enforcement
 */
export function applySoftRateLimit(
  current: number,
  limit: number,
  windowMs: number
): {
  allowed: boolean
  message?: string
  delayMs?: number
} {
  // Never hard-block, just slow down
  if (current > limit) {
    const overage = current - limit
    const delayMs = Math.min(overage * 100, 5000) // Max 5s delay

    return {
      allowed: true, // Still allow, just delayed
      message: "You're going fast. Slowing down a bit to keep things stable.",
      delayMs,
    }
  }

  return { allowed: true }
}

/**
 * Automatic scaling decision
 */
export function shouldAutoScale(metrics: UsageMetrics, baseline: UsageMetrics): {
  scale: boolean
  reason?: string
} {
  // Scale up if any metric is 2x baseline
  const apiCallsRatio = metrics.apiCalls / (baseline.apiCalls || 1)
  const usersRatio = metrics.users / (baseline.users || 1)

  if (apiCallsRatio > 2) {
    return {
      scale: true,
      reason: 'API traffic increased 2x',
    }
  }

  if (usersRatio > 2) {
    return {
      scale: true,
      reason: 'User count doubled',
    }
  }

  return { scale: false }
}

/**
 * Get user-friendly usage message
 */
export function getUsageMessage(
  current: UsageMetrics,
  limits: Record<keyof UsageMetrics, UsageLimits>
): string | null {
  const alerts = checkUsage(current, limits)
  
  // Only show positive growth messages
  const growthAlert = alerts.find(a => a.type === 'growth' && a.showToUser)
  if (growthAlert) {
    return growthAlert.message
  }

  return null
}

/**
 * NEVER return hard failure messages like:
 * ❌ "Plan limit exceeded"
 * ❌ "Upgrade required"
 * ❌ "Service unavailable"
 * 
 * ALWAYS return soft, reassuring messages:
 * ✅ "Your app is getting more usage. Everything is still working."
 * ✅ "We automatically scaled to handle increased traffic."
 * ✅ "Your app is very active. Consider reviewing performance."
 */
