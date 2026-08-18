export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * GET /v1/{projectId}/healthz
 * ────────────────────────────
 * Project-scoped health check.
 * Returns HTTP 200 with system component statuses.
 *
 * No authentication required — designed to be polled by load balancers,
 * uptime monitors, and frontend health checks.
 *
 * Response:
 * {
 *   status:    'ok' | 'degraded' | 'down',
 *   project:   { id, name, status },
 *   database:  { status: 'ok' | 'error', latencyMs: number },
 *   timestamp: string,
 *   uptime:    number,   // process uptime in seconds
 * }
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const start = Date.now()
  const checks: Record<string, any> = {}
  let overallStatus: 'ok' | 'degraded' | 'down' = 'ok'

  // ── Project check ────────────────────────────────────────────────────────────
  let projectInfo: any = null
  try {
    projectInfo = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { id: true, name: true, projectStatus: true, isDeployed: true },
    })
    if (!projectInfo) {
      return NextResponse.json(
        { status: 'down', error: 'Project not found', timestamp: new Date().toISOString() },
        { status: 404 }
      )
    }
  } catch (err: any) {
    return NextResponse.json(
      { status: 'down', error: 'Platform database unreachable', timestamp: new Date().toISOString() },
      { status: 503 }
    )
  }

  // ── Workspace database check ─────────────────────────────────────────────────
  const dbStart = Date.now()
  try {
    const schemaName = `workspace_${params.projectId}`
    await prisma.$queryRawUnsafe(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, schemaName)
    checks.database = { status: 'ok', latencyMs: Date.now() - dbStart }
  } catch (err: any) {
    checks.database = { status: 'error', latencyMs: Date.now() - dbStart, error: 'Workspace schema unreachable' }
    overallStatus = 'degraded'
  }

  return NextResponse.json(
    {
      status: overallStatus,
      project: {
        id: projectInfo.id,
        name: projectInfo.name,
        status: projectInfo.projectStatus,
        deployed: projectInfo.isDeployed,
      },
      database: checks.database,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    },
    { status: (overallStatus as string) === 'down' ? 503 : 200 }
  )
}
