/**
 * WAF Middleware
 * Intercepts requests and blocks attacks before they reach the application
 */

import { NextRequest, NextResponse } from 'next/server'
import { scanRequest, sanitizeForLogging } from '@/lib/services/waf'
import { prisma } from '@/lib/db'
import { logApiRequest } from '@/lib/services/logging'

export interface WAFConfig {
  enabled: boolean
  blockOnDetection: boolean
  logOnly: boolean
  projectId?: string
}

const defaultConfig: WAFConfig = {
  enabled: true,
  blockOnDetection: true,
  logOnly: false,
}

/**
 * WAF middleware to check requests for attacks
 */
export async function wafCheck(
  request: NextRequest,
  config: WAFConfig = defaultConfig
): Promise<{ blocked: boolean; attackType?: string; reason?: string }> {
  if (!config.enabled) {
    return { blocked: false }
  }

  try {
    // Extract request data
    const url = new URL(request.url)
    const query: Record<string, any> = {}
    url.searchParams.forEach((value, key) => {
      query[key] = value
    })

    // Get request body if available (for POST/PUT/PATCH)
    let body: any = null
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      try {
        const clonedRequest = request.clone()
        body = await clonedRequest.json().catch(() => null)
      } catch {
        // Body might not be JSON or might be streamed
      }
    }

    // Get headers
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })

    // Scan request
    const detection = scanRequest({
      query,
      body,
      headers,
      path: url.pathname,
    })

    if (detection.detected) {
      // Log the blocked attack
      const ipAddress = request.headers.get('x-forwarded-for') || 
                       request.headers.get('x-real-ip') || 
                       'unknown'
      const userAgent = request.headers.get('user-agent') || 'unknown'

      await prisma.blockedAttack.create({
        data: {
          attackType: detection.attackType!,
          pattern: detection.pattern || 'unknown',
          endpoint: url.pathname,
          method: request.method,
          ipAddress,
          userAgent,
          requestBody: body ? sanitizeForLogging(JSON.stringify(body)) : null,
          projectId: config.projectId,
          metadata: {
            query: Object.keys(query).length > 0 ? sanitizeForLogging(JSON.stringify(query)) : null,
            headers: Object.keys(headers).length > 0 ? sanitizeForLogging(JSON.stringify(headers)) : null,
          },
        },
      })

      // Log as API request with error status
      await logApiRequest({
        endpoint: url.pathname,
        method: request.method,
        statusCode: 403,
        duration: 0,
        metadata: {
          blocked: true,
          attackType: detection.attackType,
          ipAddress,
        },
      })

      // Block if configured to do so
      if (config.blockOnDetection && !config.logOnly) {
        return {
          blocked: true,
          attackType: detection.attackType,
          reason: `Blocked ${detection.attackType} attack`,
        }
      }
    }

    return { blocked: false }
  } catch (error) {
    console.error('WAF check error:', error)
    // Don't block on WAF errors - fail open
    return { blocked: false }
  }
}

/**
 * WAF wrapper for API routes
 */
export function withWAF(
  handler: (req: NextRequest, ...args: any[]) => Promise<NextResponse>,
  config?: WAFConfig
) {
  return async (req: NextRequest, ...args: any[]) => {
    const wafResult = await wafCheck(req, config)
    
    if (wafResult.blocked) {
      return NextResponse.json(
        {
          error: 'Request blocked by security policy',
          reason: wafResult.reason,
        },
        { status: 403 }
      )
    }

    return handler(req, ...args)
  }
}

