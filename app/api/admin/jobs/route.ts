export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/admin/jobs?status=failed&limit=50&offset=0
 *
 * Lists generation_jobs / render_jobs across ALL workspace schemas.
 * Useful for spotting stuck jobs, retrying failed ones, or auditing job counts.
 *
 * Query params:
 *   status   - filter by job status (failed | stuck | processing | completed)
 *   limit    - max rows per page (default 50, max 200)
 *   offset   - pagination offset (default 0)
 *
 * FOUNDER-ONLY.
 */
export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const { searchParams } = request.nextUrl
  const status   = searchParams.get('status') ?? 'failed'
  const limit    = Math.min(parseInt(searchParams.get('limit')  ?? '50'), 200)
  const offset   = parseInt(searchParams.get('offset') ?? '0')

  // Gather all workspace project IDs so we can query their schemas (cap at 500 for performance)
  const projects = await prisma.project.findMany({
    select: { id: true },
    where: { expiresAt: null, deletedAt: null },
    take: 500,
    orderBy: { updatedAt: 'desc' },
  })

  const results: any[] = []
  let totalCount = 0

  for (const project of projects) {
    const schema = `workspace_${project.id}`

    // Check which job tables exist in this workspace
    const jobTables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name IN ('generation_jobs', 'render_jobs', 'video_jobs')`,
      schema
    )

    for (const { table_name } of jobTables) {
      try {
        // For "stuck" status: jobs that have been processing for >15 minutes
        let whereClause: string
        if (status === 'stuck') {
          whereClause = `status = 'processing' AND "createdAt" < NOW() - INTERVAL '15 minutes'`
        } else {
          whereClause = `status = $2`
        }

        // Count
        const countSql = status === 'stuck'
          ? `SELECT COUNT(*)::int AS count FROM "${schema}"."${table_name}" WHERE ${whereClause}`
          : `SELECT COUNT(*)::int AS count FROM "${schema}"."${table_name}" WHERE status = $2`

        const countRows = status === 'stuck'
          ? await prisma.$queryRawUnsafe<{ count: number }[]>(countSql, schema)
          : await prisma.$queryRawUnsafe<{ count: number }[]>(countSql, schema, status)

        const tableCount = Number(countRows[0]?.count ?? 0)
        totalCount += tableCount

        if (tableCount === 0) continue

        // Fetch rows (apply global offset/limit spread across tables — simplified to per-table here)
        const dataSql = status === 'stuck'
          ? `SELECT *, '${project.id}' AS "_projectId", '${table_name}' AS "_table"
             FROM "${schema}"."${table_name}"
             WHERE ${whereClause}
             ORDER BY "createdAt" DESC LIMIT ${limit} OFFSET ${offset}`
          : `SELECT *, '${project.id}' AS "_projectId", '${table_name}' AS "_table"
             FROM "${schema}"."${table_name}"
             WHERE status = $2
             ORDER BY "createdAt" DESC LIMIT ${limit} OFFSET ${offset}`

        const rows = status === 'stuck'
          ? await prisma.$queryRawUnsafe<any[]>(dataSql)
          : await prisma.$queryRawUnsafe<any[]>(dataSql, schema, status)

        results.push(...rows)
      } catch {
        // Non-fatal: table might not have all expected columns
      }
    }
  }

  // Sort merged results by createdAt desc and apply global limit
  results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const paginated = results.slice(0, limit)

  return NextResponse.json({
    jobs: paginated,
    total: totalCount,
    limit,
    offset,
    hasMore: offset + paginated.length < totalCount,
    statusFilter: status,
  })
}

/**
 * POST /api/admin/jobs
 *
 * Retry or cancel a specific job by project + table + job ID.
 *
 * Body: { projectId, table, jobId, action: "retry" | "cancel" }
 */
export async function POST(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const body = await request.json()
  const { projectId, table, jobId, action } = body ?? {}

  if (!projectId || !table || !jobId || !action) {
    return NextResponse.json({ error: 'projectId, table, jobId, and action are required' }, { status: 400 })
  }

  if (!['retry', 'cancel'].includes(action)) {
    return NextResponse.json({ error: 'action must be "retry" or "cancel"' }, { status: 400 })
  }

  // Validate identifiers (prevent injection)
  if (!/^[a-z0-9_-]{36}$/.test(projectId) || !/^[a-z_]+$/.test(table)) {
    return NextResponse.json({ error: 'Invalid projectId or table name' }, { status: 400 })
  }

  const schema = `workspace_${projectId}`

  // Verify table exists
  const tableCheck = await prisma.$queryRawUnsafe<{ count: number }[]>(
    `SELECT COUNT(*)::int AS count FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    schema, table
  )
  if (!Number(tableCheck[0]?.count)) {
    return NextResponse.json({ error: 'Table not found in workspace' }, { status: 404 })
  }

  try {
    if (action === 'retry') {
      await prisma.$executeRawUnsafe(
        `UPDATE "${schema}"."${table}"
         SET status = 'queued', attempts = COALESCE(attempts, 0) + 1,
             error_message = NULL, "updatedAt" = NOW()
         WHERE id = $1 AND status = 'failed'`,
        jobId
      )
    } else {
      await prisma.$executeRawUnsafe(
        `UPDATE "${schema}"."${table}"
         SET status = 'cancelled', "updatedAt" = NOW()
         WHERE id = $1 AND status IN ('queued', 'processing', 'failed')`,
        jobId
      )
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'DB update failed' }, { status: 500 })
  }

  return NextResponse.json({ success: true, jobId, action })
}
