import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { prisma } from '@/lib/db'
import { rollbackDeploy } from '@/lib/deployment/rollback'
import { listPublishedVersions } from '@/lib/deployment/published-versions'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/[id]/rollback
 * Returns published deployment versions for the project.
 *
 * POST /api/projects/[id]/rollback
 * Rollback to a specific published deployment version.
 * Reverts the activeGraphId to the graph that was published at that version.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const sessionToken = request.cookies.get('auth-token')?.value
    if (!sessionToken) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const decoded = await verifyToken(sessionToken)
    const userId = decoded.userId
    const projectId = params.id

    // Verify project access
    if (!(await canAccessProject(userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // One authority, shared with the agent's deploy { action: "history" }.
    const history = await listPublishedVersions(projectId)
    if (!history) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, ...history })
  } catch (error: any) {
    console.error('[Rollback API] GET Error:', error)
    return NextResponse.json({ error: 'Failed to load deployment versions' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
