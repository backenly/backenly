export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
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

      // ── One answer from BOTH record stores ─────────────────────────────
      //
      // Project traffic has never been written to `Log`: its only writers are
      // platform auth events with no projectId, so this explorer rendered
      // "No logs yet" forever while api_request_logs filled with the real
      // requests. The union below reads both — legacy Log rows AND runtime
      // requests mapped into the same shape — and pages, counts and groups in
      // the database so the explorer's numbers are about the union, not about
      // whichever source happened to fill the page.
      const values: unknown[] = [projectId]
      const n = () => `$${values.length}`

      // Log-side conditions mirror the old prisma where-clause.
      const logConds: string[] = [`"projectId" = $1`]
      if (params.type && params.type !== 'all') { values.push(params.type); logConds.push(`"type" = ${n()}`) }
      if (params.severity && params.severity !== 'all') { values.push(params.severity); logConds.push(`"severity" = ${n()}`) }
      if (params.service) { values.push(params.service); logConds.push(`"service" = ${n()}`) }
      if (params.search) {
        values.push(`%${params.search}%`)
        const i = n()
        logConds.push(`("message" ILIKE ${i} OR "endpoint" ILIKE ${i} OR "service" ILIKE ${i})`)
      }
      if (params.startDate) { values.push(new Date(params.startDate).toISOString()); logConds.push(`"timestamp" >= (${n()}::timestamptz AT TIME ZONE 'UTC')`) }
      if (params.endDate) { values.push(new Date(params.endDate).toISOString()); logConds.push(`"timestamp" <= (${n()}::timestamptz AT TIME ZONE 'UTC')`) }

      // Request-side conditions: runtime rows surface as type 'api', with
      // severity derived from the status code. Preview-branch traffic is kept
      // out, matching every production monitoring reader.
      const reqConds: string[] = [`"projectId" = $1`, `"branchId" IS NULL`]
      if (params.type && params.type !== 'all' && params.type !== 'api') reqConds.push('FALSE')
      if (params.severity && params.severity !== 'all') {
        if (params.severity === 'error') reqConds.push(`"statusCode" >= 500`)
        else if (params.severity === 'warning') reqConds.push(`"statusCode" >= 400 AND "statusCode" < 500`)
        else if (params.severity === 'info') reqConds.push(`"statusCode" < 400`)
        else reqConds.push('FALSE') // debug has no runtime equivalent
      }
      if (params.service && params.service !== 'runtime') reqConds.push('FALSE')
      if (params.search) {
        values.push(`%${params.search}%`)
        const i = n()
        reqConds.push(`("path" ILIKE ${i} OR "method" ILIKE ${i})`)
      }
      if (params.startDate) { values.push(new Date(params.startDate).toISOString()); reqConds.push(`"timestamp" >= (${n()}::timestamptz AT TIME ZONE 'UTC')`) }
      if (params.endDate) { values.push(new Date(params.endDate).toISOString()); reqConds.push(`"timestamp" <= (${n()}::timestamptz AT TIME ZONE 'UTC')`) }

      const unionSql = `
        SELECT "id", "type", "severity", "message", "service", "endpoint",
               "method", "statusCode", "duration", "timestamp"
          FROM "logs"
         WHERE ${logConds.join(' AND ')}
        UNION ALL
        SELECT "id",
               'api' AS "type",
               CASE WHEN "statusCode" >= 500 THEN 'error'
                    WHEN "statusCode" >= 400 THEN 'warning'
                    ELSE 'info' END AS "severity",
               "method" || ' ' || "path" || ' -> ' || "statusCode"::text AS "message",
               'runtime' AS "service",
               "path" AS "endpoint",
               "method",
               "statusCode",
               "duration",
               "timestamp"
          FROM "api_request_logs"
         WHERE ${reqConds.join(' AND ')}`

      const { prisma: rawDb } = await import('@/lib/db/prisma')
      const [logs, totalRows, severityGroups] = await Promise.all([
        rawDb.$queryRawUnsafe<any[]>(
          `SELECT * FROM (${unionSql}) u ORDER BY "timestamp" DESC LIMIT ${limit} OFFSET ${skip}`,
          ...values
        ),
        rawDb.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int AS count FROM (${unionSql}) u`,
          ...values
        ),
        rawDb.$queryRawUnsafe<Array<{ severity: string; count: number }>>(
          `SELECT "severity", COUNT(*)::int AS count FROM (${unionSql}) u GROUP BY "severity"`,
          ...values
        ),
      ])
      const total = totalRows[0]?.count ?? 0

      // Zeroes are kept explicit. A severity missing from the group-by means
      // none matched, and the UI renders a count of 0 rather than a gap.
      const severityCounts = { error: 0, warning: 0, info: 0, debug: 0 }
      for (const g of severityGroups) {
        if (g.severity in severityCounts) {
          severityCounts[g.severity as keyof typeof severityCounts] = g.count
        }
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

