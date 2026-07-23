/**
 * 🔒 SECURITY AUDIT LOGGING
 * 
 * Enterprise-grade security event tracking
 * Critical for: Debugging, Legal protection, SOC2, Trust
 */

import { prisma } from '@/lib/db/postgres'

export type SecurityEventType =
  | 'AUTH_FAILED'
  | 'AUTH_SUCCESS'
  | 'CROSS_PROJECT_ACCESS_ATTEMPT'
  | 'INVALID_API_KEY'
  | 'API_KEY_EXPIRED'
  | 'API_KEY_USED'
  | 'FORBIDDEN_ACCESS'
  | 'UNAUTHORIZED_ACCESS'
  | 'AI_CONTEXT_VIOLATION'
  | 'RLS_VIOLATION'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SUSPICIOUS_ACTIVITY'
  | 'ADMIN_ACTION'
  | 'PROJECT_CREATED'
  | 'PROJECT_DELETED'
  | 'DATA_EXPORT'
  | 'SCHEMA_MODIFIED'

export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'

export interface SecurityAuditLog {
  eventType: SecurityEventType
  severity: SecuritySeverity
  userId?: string
  projectId?: string
  ipAddress?: string
  userAgent?: string
  details?: Record<string, any>
  endpoint?: string
  method?: string
  success?: boolean
}

/**
 * Log security event to audit table
 */
export async function logSecurityEvent(event: SecurityAuditLog) {
  try {
    // Use main prisma client (not scoped by project)
    await prisma.auditLog.create({
      data: {
        type: 'security',
        action: event.eventType,
        userId: event.userId || null,
        projectId: event.projectId || null,
        details: JSON.stringify({
          severity: event.severity,
          ipAddress: event.ipAddress,
          userAgent: event.userAgent,
          endpoint: event.endpoint,
          method: event.method,
          success: event.success,
          ...event.details,
        }),
        timestamp: new Date(),
      },
    })

    // Also log to console for immediate visibility
    const icon = getSeverityIcon(event.severity)
    console.log(
      `${icon} [SECURITY AUDIT] ${event.eventType} | User: ${event.userId || 'unknown'} | Project: ${event.projectId || 'none'}`
    )

    if (event.severity === 'critical' || event.severity === 'high') {
      console.error(`🚨 HIGH SEVERITY EVENT:`, JSON.stringify(event, null, 2))
    }
  } catch (error) {
    // Never let audit logging crash the app
    console.error('❌ Failed to log security event:', error)
  }
}

/**
 * Helper: Get icon for severity level
 */
function getSeverityIcon(severity: SecuritySeverity): string {
  switch (severity) {
    case 'critical':
      return '🚨'
    case 'high':
      return '⚠️'
    case 'medium':
      return '🔶'
    case 'low':
      return '🔵'
    default:
      return '📊'
  }
}

/**
 * Pre-configured audit functions for common scenarios
 */
export const SecurityAudit = {
  /**
   * Log failed authentication attempt
   */
  authFailed: (userId: string, ipAddress: string, reason: string) =>
    logSecurityEvent({
      eventType: 'AUTH_FAILED',
      severity: 'medium',
      userId,
      ipAddress,
      success: false,
      details: { reason },
    }),

  /**
   * Log successful authentication
   */
  authSuccess: (userId: string, ipAddress: string) =>
    logSecurityEvent({
      eventType: 'AUTH_SUCCESS',
      severity: 'low',
      userId,
      ipAddress,
      success: true,
    }),

  /**
   * Log cross-project access attempt (CRITICAL)
   */
  crossProjectAccess: (
    userId: string,
    attemptedProjectId: string,
    allowedProjectId: string,
    endpoint: string
  ) =>
    logSecurityEvent({
      eventType: 'CROSS_PROJECT_ACCESS_ATTEMPT',
      severity: 'critical',
      userId,
      projectId: allowedProjectId,
      endpoint,
      success: false,
      details: {
        attemptedProjectId,
        allowedProjectId,
        message: 'User attempted to access project they do not own',
      },
    }),

  /**
   * Log invalid API key usage
   */
  invalidApiKey: (apiKey: string, ipAddress: string, endpoint: string) =>
    logSecurityEvent({
      eventType: 'INVALID_API_KEY',
      severity: 'high',
      ipAddress,
      endpoint,
      success: false,
      details: { apiKeyPrefix: apiKey.substring(0, 8) },
    }),

  /**
   * Log API key usage (for rate limiting tracking)
   */
  apiKeyUsed: (apiKey: string, projectId: string, endpoint: string) =>
    logSecurityEvent({
      eventType: 'API_KEY_USED',
      severity: 'low',
      projectId,
      endpoint,
      success: true,
      details: { apiKeyPrefix: apiKey.substring(0, 8) },
    }),

  /**
   * Log forbidden access (403)
   */
  forbiddenAccess: (
    userId: string,
    projectId: string,
    endpoint: string,
    reason: string
  ) =>
    logSecurityEvent({
      eventType: 'FORBIDDEN_ACCESS',
      severity: 'high',
      userId,
      projectId,
      endpoint,
      success: false,
      details: { reason },
    }),

  /**
   * Log AI context violation
   */
  aiContextViolation: (
    userId: string,
    projectId: string,
    attemptedAccess: string
  ) =>
    logSecurityEvent({
      eventType: 'AI_CONTEXT_VIOLATION',
      severity: 'critical',
      userId,
      projectId,
      success: false,
      details: {
        attemptedAccess,
        message: 'AI attempted to access data outside project scope',
      },
    }),

  /**
   * Log rate limit exceeded
   */
  rateLimitExceeded: (
    userId: string,
    projectId: string,
    endpoint: string,
    limit: number
  ) =>
    logSecurityEvent({
      eventType: 'RATE_LIMIT_EXCEEDED',
      severity: 'medium',
      userId,
      projectId,
      endpoint,
      success: false,
      details: { limit, message: 'User exceeded rate limit' },
    }),

  /**
   * Log admin action
   */
  adminAction: (
    userId: string,
    action: string,
    targetProjectId?: string,
    details?: Record<string, any>
  ) =>
    logSecurityEvent({
      eventType: 'ADMIN_ACTION',
      severity: 'high',
      userId,
      projectId: targetProjectId,
      success: true,
      details: { action, ...details },
    }),

  /**
   * Log project deletion (for recovery/audit)
   */
  projectDeleted: (userId: string, projectId: string, projectName: string) =>
    logSecurityEvent({
      eventType: 'PROJECT_DELETED',
      severity: 'high',
      userId,
      projectId,
      success: true,
      details: { projectName, timestamp: new Date().toISOString() },
    }),
}

/**
 * Query audit logs for a project (with pagination)
 */
export async function getProjectAuditLogs(
  projectId: string,
  options?: {
    limit?: number
    offset?: number
    severity?: SecuritySeverity
    startDate?: Date
    endDate?: Date
  }
) {
  const { limit = 100, offset = 0, severity, startDate, endDate } = options || {}

  return await prisma.auditLog.findMany({
    where: {
      projectId,
      type: 'security',
      ...(startDate && {
        timestamp: {
          gte: startDate,
        },
      }),
      ...(endDate && {
        timestamp: {
          lte: endDate,
        },
      }),
    },
    orderBy: {
      timestamp: 'desc',
    },
    take: limit,
    skip: offset,
  })
}

/**
 * Get security statistics for a project
 */
export async function getSecurityStats(projectId: string, days: number = 30) {
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days)

  const logs = await prisma.auditLog.findMany({
    where: {
      projectId,
      type: 'security',
      timestamp: {
        gte: startDate,
      },
    },
  })

  const parseDetails = (details: any) => {
    try {
      return typeof details === 'string' ? JSON.parse(details) : details
    } catch {
      return {}
    }
  }

  const stats = {
    total: logs.length,
    bySeverity: {
      critical: logs.filter((l) => parseDetails(l.details)?.severity === 'critical').length,
      high: logs.filter((l) => parseDetails(l.details)?.severity === 'high').length,
      medium: logs.filter((l) => parseDetails(l.details)?.severity === 'medium').length,
      low: logs.filter((l) => parseDetails(l.details)?.severity === 'low').length,
    },
    byType: logs.reduce((acc, log) => {
      const type = log.action || 'unknown'
      acc[type] = (acc[type] || 0) + 1
      return acc
    }, {} as Record<string, number>),
    recentCritical: logs
      .filter((l) => parseDetails(l.details)?.severity === 'critical')
      .slice(0, 10)
      .map((l) => ({
        action: l.action,
        timestamp: l.timestamp,
        details: parseDetails(l.details),
      })),
  }

  return stats
}

