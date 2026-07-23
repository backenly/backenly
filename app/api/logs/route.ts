export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createTenantPrisma } from '@/lib/tenant/prisma'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { z } from 'zod'

const querySchema = z.object({
  page: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 1)),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  type: z.enum(['api', 'auth', 'database', 'function', 'system', 'all']).optional(),
  severity: z.enum(['error', 'warning', 'info', 'debug', 'all']).optional(),
  service: z.string().optional(),
  search: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
})

export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const tenantPrisma = createTenantPrisma(projectId)

      const searchParams = request.nextUrl.searchParams
      const params = querySchema.parse({
        page: searchParams.get('page') || undefined,
        limit: searchParams.get('limit') || undefined,
        type: searchParams.get('type') || undefined,
        severity: searchParams.get('severity') || undefined,
        service: searchParams.get('service') || undefined,
        search: searchParams.get('search') || undefined,
        startDate: searchParams.get('startDate') || undefined,
        endDate: searchParams.get('endDate') || undefined,
      })

      const page = params.page || 1
      const limit = Math.min(params.limit || 50, 100) // Max 100 per page
      const skip = (page - 1) * limit

      // Build where clause (projectId is automatically added by tenantPrisma)
      const where: any = {
        projectId, // Enforced by tenant isolation
      }

      // Filter by type
      if (params.type && params.type !== 'all') {
        where.type = params.type
      }

      // Filter by severity
      if (params.severity && params.severity !== 'all') {
        where.severity = params.severity
      }

      // Filter by service
      if (params.service) {
        where.service = params.service
      }

      // Text search
      if (params.search) {
        where.OR = [
          { message: { contains: params.search, mode: 'insensitive' } },
          { endpoint: { contains: params.search, mode: 'insensitive' } },
          { service: { contains: params.search, mode: 'insensitive' } },
        ]
      }

      // Date range filter
      if (params.startDate || params.endDate) {
        where.timestamp = {}
        if (params.startDate) {
          where.timestamp.gte = new Date(params.startDate)
        }
        if (params.endDate) {
          where.timestamp.lte = new Date(params.endDate)
        }
      }

      // Get logs with pagination (automatically scoped to project)
      const [logs, allLogs] = await Promise.all([
        tenantPrisma.log.findMany({
          where,
          orderBy: { timestamp: 'desc' },
          skip,
          take: limit,
        }),
        tenantPrisma.log.findMany({ where }),
      ])

      const total = allLogs.length

      // Get summary stats (scoped to this project)
      const severityCounts = {
        error: allLogs.filter(l => l.severity === 'error').length,
        warning: allLogs.filter(l => l.severity === 'warning').length,
        info: allLogs.filter(l => l.severity === 'info').length,
        debug: allLogs.filter(l => l.severity === 'debug').length,
      }

      return NextResponse.json({
        logs,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        stats: {
          total,
          ...severityCounts,
        },
      })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
    console.error('Error fetching logs:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch logs' },
      { status: 500 }
    )
  }
}

