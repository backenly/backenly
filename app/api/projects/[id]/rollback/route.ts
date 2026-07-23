import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { prisma } from '@/lib/db'
import { rollbackDeploy } from '@/lib/deployment/rollback'

/**
 * GET /api/projects/[id]/rollback
 * Returns published deployment versions for the project.
 *
 * POST /api/projects/[id]/rollback
 * Rollback to a specific published deployment version.
 * Reverts the activeGraphId to the graph that was published at that version.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    // Verify project access
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true, activeGraphId: true },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Fetch all published deployment versions
    const deployments = await prisma.deployment.findMany({
      where: {
        projectId,
        environment: 'live',
        status: 'live',
        version: { not: null },
      },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        graphSnapshotId: true,
        changeSummary: true,
        completedAt: true,
        createdAt: true,
        url: true,
      },
    })

    // Mark which deployment is currently active. After a rollback + republish,
    // several versions can share the same graphSnapshotId — only the newest
    // match is "active", and rolling back to any snapshot that equals the
    // live graph is a no-op the engine rejects, so those rows get no button.
    const activeIdx = deployments.findIndex(d => d.graphSnapshotId === project.activeGraphId)
    const versions = deployments.map((d, idx) => ({
      id: d.id,
      version: d.version,
      graphSnapshotId: d.graphSnapshotId,
      changeSummary: d.changeSummary || 'Published',
      publishedAt: d.completedAt?.toISOString() || d.createdAt.toISOString(),
      isActive: idx === activeIdx,
      isCurrent: idx === 0, // Latest version
      canRollback: !!d.graphSnapshotId && d.graphSnapshotId !== project.activeGraphId,
    }))

    return NextResponse.json({
      success: true,
      versions,
      currentVersion: versions.find(v => v.isActive)?.version || versions[0]?.version || 0,
      latestVersion: versions[0]?.version || 0,
    })
  } catch (error: any) {
    console.error('[Rollback API] GET Error:', error)
    return NextResponse.json({ error: 'Failed to load deployment versions' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json().catch(() => ({}))
    const { deploymentId, version } = body

    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
    }
    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    // UI button click is its own confirmation — pass force:true so the engine
    // skips the "Type ROLLBACK" prompt (that's the chat path's second-layer gate).
    const result = await rollbackDeploy({
      projectId,
      userId,
      deploymentId,
      version,
      confirmedBy: 'UI',
      force: true,
    })

    if (result.kind === 'error') {
      const status =
        result.code === 'PLAN_LIMIT_EXCEEDED' ? 403 :
        result.code === 'NOT_FOUND' ? 404 :
        result.code === 'INVALID' ? 400 : 500
      return NextResponse.json(
        { success: false, error: result.error, code: result.code, upgradeRequired: result.code === 'PLAN_LIMIT_EXCEEDED' || undefined },
        { status }
      )
    }

    // UI passes force:true so a 'confirmation' here would be a programming error.
    if (result.kind === 'confirmation') {
      return NextResponse.json({ success: false, error: 'Unexpected confirmation gate on UI rollback' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: result.message,
      version: result.toVersion,
    })
  } catch (error: any) {
    console.error('[Rollback API] POST Error:', error)
    return NextResponse.json(
      { success: false, error: error.message || 'Rollback failed' },
      { status: 500 }
    )
  }
}
