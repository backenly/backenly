export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, ErrorCodes } from '@/lib/api/v1/errors'
import { getLogsSchema } from '@/lib/api/v1/schemas'
import { validateQueryParams } from '@/lib/validation/schemas'
import { prisma } from '@/lib/db'

/**
 * GET /v1/{projectId}/logs
 * Get logs (read-only)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) {
      return middleware.response
    }

    const { context } = middleware

    // Logs are read-only, so read permission is sufficient
    const permissionCheck = requirePermission(context, ['read', 'admin'])
    if (permissionCheck) {
      return permissionCheck
    }

    const capabilityCheck = requireCapability(context, request.nextUrl.pathname)
    if (capabilityCheck) {
      return capabilityCheck
    }

    const searchParams = request.nextUrl.searchParams
    const type = searchParams.get('type') as any
    const severity = searchParams.get('severity') as any
    const limit = parseInt(searchParams.get('limit') || '100', 10)
    const offset = parseInt(searchParams.get('offset') || '0', 10)
    const startTime = searchParams.get('startTime')
    const endTime = searchParams.get('endTime')

    // Build where clause
    const where: any = {
      projectId: context.projectId,
    }

    if (type) {
      where.type = type
    }

    if (severity) {
      where.severity = severity
    }

    if (startTime || endTime) {
      where.createdAt = {}
      if (startTime) {
        where.createdAt.gte = new Date(startTime)
      }
      if (endTime) {
        where.createdAt.lte = new Date(endTime)
      }
    }

    // Fetch logs
    const [logs, total] = await Promise.all([
      prisma.log.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          type: true,
          severity: true,
          message: true,
          metadata: true,
          createdAt: true,
        },
      }),
      prisma.log.count({ where }),
    ])

    return createSuccessResponse(
      logs,
      {
        limit,
        page: Math.floor(offset / limit),
        total,
        hasMore: offset + logs.length < total,
      }
    )
  } catch (error: any) {
    console.error('Logs fetch error:', error)
    return createErrorResponse(
      ErrorCodes.INTERNAL_ERROR,
      'Failed to fetch logs',
      500
    )
  }
}

