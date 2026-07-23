/**
 * Middleware to automatically record metrics from API requests
 */

import { NextRequest, NextResponse } from 'next/server'
import { recordMetric } from '@/lib/services/metrics'
import { logApiRequest } from '@/lib/services/logging'

export async function recordRequestMetrics(
  request: NextRequest,
  response: NextResponse,
  responseTime: number
) {
  try {
    const path = request.nextUrl.pathname
    const method = request.method
    const statusCode = response.status

    // Record response time
    await recordMetric({
      type: 'responseTime',
      source: 'api',
      sourceId: `${method} ${path}`,
      value: responseTime,
      metadata: {
        method,
        path,
        statusCode,
      },
    })

    // Record request volume
    await recordMetric({
      type: 'requestVolume',
      source: 'api',
      sourceId: `${method} ${path}`,
      value: 1,
      metadata: {
        method,
        path,
        statusCode,
      },
    })

    // Record error rate (if status code indicates error)
    if (statusCode >= 400) {
      await recordMetric({
        type: 'errorRate',
        source: 'api',
        sourceId: `${method} ${path}`,
        value: 1,
        metadata: {
          method,
          path,
          statusCode,
        },
      })
    }

    // Log API request
    const userId = request.headers.get('x-user-id') || undefined
    const projectId = request.headers.get('x-project-id') || undefined
    
    await logApiRequest({
      endpoint: path,
      method,
      statusCode,
      duration: responseTime,
      userId,
      projectId,
      metadata: {
        userAgent: request.headers.get('user-agent'),
        ip: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip'),
      },
    })
  } catch (error) {
    // Don't fail the request if metrics recording fails
    console.error('Failed to record metrics:', error)
  }
}

/**
 * Wrapper to automatically record metrics for API routes
 */
export function withMetrics(handler: (req: NextRequest, ...args: any[]) => Promise<NextResponse>) {
  return async (req: NextRequest, ...args: any[]) => {
    const startTime = Date.now()
    const response = await handler(req, ...args)
    const responseTime = Date.now() - startTime

    // Record metrics asynchronously (don't block response)
    recordRequestMetrics(req, response, responseTime).catch(console.error)

    return response
  }
}

