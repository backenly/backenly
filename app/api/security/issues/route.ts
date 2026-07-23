export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createTenantPrisma } from '@/lib/tenant/prisma'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { z } from 'zod'

const querySchema = z.object({
  page: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 1)),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  severity: z.enum(['high', 'medium', 'low', 'all']).optional(),
  category: z.string().optional(),
  fixed: z.string().optional().transform((val) => val === 'true'),
})

export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const tenantPrisma = createTenantPrisma(projectId)

      const searchParams = request.nextUrl.searchParams
      const params = querySchema.parse({
        page: searchParams.get('page') || undefined,
        limit: searchParams.get('limit') || undefined,
        severity: searchParams.get('severity') || undefined,
        category: searchParams.get('category') || undefined,
        fixed: searchParams.get('fixed') || undefined,
      })

      const page = params.page || 1
      const limit = Math.min(params.limit || 50, 100)
      const skip = (page - 1) * limit

      const where: any = {
        projectId, // Enforced by tenant isolation
      }

      if (params.severity && params.severity !== 'all') {
        where.severity = params.severity
      }

      if (params.category) {
        where.category = params.category
      }

      if (params.fixed !== undefined) {
        where.fixed = params.fixed
      }

      const [issues, total] = await Promise.all([
        tenantPrisma.securityIssue.findMany({
          where,
          orderBy: [
            { severity: 'desc' }, // high first
            { detectedAt: 'desc' },
          ],
          skip,
          take: limit,
        }),
        tenantPrisma.securityIssue.findMany({ where }).then(r => r.length),
      ])

      // Get summary stats (scoped to this project)
      const allIssues = await tenantPrisma.securityIssue.findMany({
        where: { ...where, fixed: false },
      })

      const severityCounts = {
        high: allIssues.filter(i => i.severity === 'high').length,
        medium: allIssues.filter(i => i.severity === 'medium').length,
        low: allIssues.filter(i => i.severity === 'low').length,
      }

      return NextResponse.json({
        issues,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        stats: {
          total: total,
          unfixed: allIssues.length,
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
    console.error('Error fetching security issues:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch security issues' },
      { status: 500 }
    )
  }
}

