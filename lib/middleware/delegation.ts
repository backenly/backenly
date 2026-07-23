/**
 * Delegation Token Middleware
 * 
 * Validates delegation tokens for MCP/AI agent access
 * Checks permissions and token validity
 * Includes rate limiting and audit logging
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import crypto from 'crypto'

export interface DelegationContext {
  connectionId: string
  projectId: string
  provider: 'cursor' | 'replit' | 'web'
  permissions: {
    readSchema: boolean
    readEndpoints: boolean
    callApis: boolean
    authenticateSessions: boolean
  }
  usageCount: number
}

/**
 * Validate delegation token from request
 * Returns delegation context if valid, null otherwise
 * Includes rate limiting check
 */
export async function validateDelegationToken(
  request: NextRequest
): Promise<DelegationContext | null> {
  // Check for delegation token in Authorization header or query param
  const authHeader = request.headers.get('authorization')
  const tokenFromHeader = authHeader?.startsWith('Bearer del_') 
    ? authHeader.substring(7) 
    : null
  
  const { searchParams } = new URL(request.url)
  const tokenFromQuery = searchParams.get('delegationToken')
  
  const token = tokenFromHeader || tokenFromQuery
  
  if (!token || !token.startsWith('del_')) {
    return null
  }
  
  try {
    // Hash token to look it up
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    
    // Find active connection
    const connection = await prisma.delegatedConnection.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    })
    
    if (!connection) {
      return null
    }
    
    // Rate limiting check (1000 requests per 24h period)
    const RATE_LIMIT = 1000
    if (connection.usageCount >= RATE_LIMIT) {
      // Log rate limit violation
      await logAuditEvent(
        connection.id,
        'rate_limit_exceeded',
        request.url,
        request,
        { usageCount: connection.usageCount, limit: RATE_LIMIT }
      )
      return null
    }
    
    // Update usage stats (async, no await to avoid latency)
    prisma.delegatedConnection.update({
      where: { id: connection.id },
      data: { 
        lastUsedAt: new Date(),
        usageCount: { increment: 1 },
      },
    }).catch(() => {
      // Ignore errors, this is just telemetry
    })
    
    // Return delegation context
    return {
      connectionId: connection.id,
      projectId: connection.projectId,
      provider: connection.provider as 'cursor' | 'replit' | 'web',
      permissions: connection.permissions as DelegationContext['permissions'],
      usageCount: connection.usageCount,
    }
  } catch (error) {
    console.error('[Delegation Middleware] Error:', error)
    return null
  }
}

/**
 * Require delegation permission
 * Checks if the delegation context has the required permission
 */
export function requirePermission(
  context: DelegationContext | null,
  permission: keyof DelegationContext['permissions']
): boolean {
  if (!context) return false
  return context.permissions[permission] === true
}

/**
 * Get project ID from delegation context or query params
 * Prioritizes delegation context over query params for security
 */
export function getProjectId(
  request: NextRequest,
  context: DelegationContext | null
): string | null {
  // Delegation context takes priority (more secure)
  if (context?.projectId) {
    return context.projectId
  }
  
  // Fallback to query param (for backward compatibility)
  const { searchParams } = new URL(request.url)
  return searchParams.get('projectId')
}

/**
 * Log audit event for delegation activity
 */
export async function logAuditEvent(
  connectionId: string,
  action: 'created' | 'used' | 'revoked' | 'expired' | 'permission_denied' | 'rate_limit_exceeded',
  endpoint: string,
  request: NextRequest,
  metadata?: any
): Promise<void> {
  try {
    const ipAddress = request.headers.get('x-forwarded-for') || 
                      request.headers.get('x-real-ip') || 
                      'unknown'
    const userAgent = request.headers.get('user-agent') || 'unknown'
    
    await prisma.delegationAuditLog.create({
      data: {
        connectionId,
        action,
        endpoint,
        ipAddress,
        userAgent,
        metadata: metadata || {},
      },
    })
  } catch (error) {
    // Don't throw - audit logging should never break the main flow
    console.error('[Audit Log] Failed to log event:', error)
  }
}
