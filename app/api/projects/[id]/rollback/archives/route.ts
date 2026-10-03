/**
 * Archived Tables Management API
 * 
 * Internal endpoint for viewing archived tables and PITR snapshots
 * Used by support/admin only - not exposed to users
 * 
 * PHILOSOPHY: Users never see restore options, but we can recover if needed
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { listArchivedTables, listPITRSnapshots, restoreToPITRSnapshot } from '@/lib/rollback/non-destructive-restore'
import { ExecutionContext } from '@/lib/context/execution-context'
import { canAdministerProject } from '@/lib/edition/guard'

export const dynamic = 'force-dynamic'

/**
 * GET /api/projects/[projectId]/rollback/archives
 * List archived tables and PITR snapshots for recovery
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Verify authentication
    const authHeader = request.headers.get('authorization')
    const cookieToken = request.cookies.get('auth_token')?.value

    if (!authHeader && !cookieToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader?.substring(7) || cookieToken
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const payload = verifyToken(token!)
    if (!payload || !payload.userId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const projectId = params.id

    // Verify project ownership
    const { prisma } = await import('@/lib/db')
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // ADMIN for the read as well as the restore. This file's own header says
    // "Used by support/admin only - not exposed to users", and listing PITR
    // snapshots and archived tables is reconnaissance for a restore rather than
    // ordinary project reading.
    //
    // The 404/403 split above is deliberately KEPT. Unlike the rest of this
    // route family, this endpoint already distinguished a missing project from
    // a forbidden one, so collapsing it into 404 here would be changing
    // behaviour rather than preserving it.
    if (!(await canAdministerProject(payload.userId, projectId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // List archived tables
    const archives = await listArchivedTables(projectId)

    // List PITR snapshots
    const snapshots = await listPITRSnapshots(projectId)

    return NextResponse.json({
      success: true,
      projectId,
      archives: archives.map(a => ({
        originalTable: a.originalTable,
        archivedTable: a.archivedTable,
        archivedAt: a.archivedAt,
        canRestore: a.canRestore,
        ageInDays: Math.floor(
          (Date.now() - new Date(a.archivedAt).getTime()) / (1000 * 60 * 60 * 24)
        ),
      })),
      snapshots: snapshots.map(s => ({
        id: s.id,
        capturedAt: s.capturedAt,
        canRestoreTo: s.canRestoreTo,
        ageInHours: Math.floor(
          (Date.now() - new Date(s.capturedAt).getTime()) / (1000 * 60 * 60)
        ),
        tableCount: s.schemaState.tables?.length || 0,
      })),
      retentionPolicy: {
        archiveRetentionDays: 90,
        snapshotRetentionDays: 30,
        description: 'Archives older than 90 days may be permanently deleted. Snapshots older than 30 days are invalidated.',
      },
    })
  } catch (error: any) {
    console.error('[Archives API] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to list archives' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/projects/[projectId]/rollback/archives/restore
 * Restore to a PITR snapshot (admin/support only)
 * 
 * INTERNAL USE ONLY - Not exposed to users
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Verify authentication
    const authHeader = request.headers.get('authorization')
    const cookieToken = request.cookies.get('auth_token')?.value

    if (!authHeader && !cookieToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader?.substring(7) || cookieToken
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const payload = verifyToken(token!)
    if (!payload || !payload.userId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const projectId = params.id
    const body = await request.json()
    const { snapshotId } = body

    if (!snapshotId) {
      return NextResponse.json({ error: 'snapshotId required' }, { status: 400 })
    }

    // Verify project ownership
    const { prisma } = await import('@/lib/db')
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // ADMIN for the read as well as the restore. This file's own header says
    // "Used by support/admin only - not exposed to users", and listing PITR
    // snapshots and archived tables is reconnaissance for a restore rather than
    // ordinary project reading.
    //
    // The 404/403 split above is deliberately KEPT. Unlike the rest of this
    // route family, this endpoint already distinguished a missing project from
    // a forbidden one, so collapsing it into 404 here would be changing
    // behaviour rather than preserving it.
    if (!(await canAdministerProject(payload.userId, projectId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Create execution context
    const context: ExecutionContext = {
      projectId,
      userId: payload.userId,
      executionId: crypto.randomUUID(),
      timestamp: new Date(),
      source: 'api',
    }

    // Restore to PITR snapshot
    const result = await restoreToPITRSnapshot(context, snapshotId)

    return NextResponse.json({
      success: result.success,
      snapshotId,
      tablesRestored: result.tablesRestored,
      tablesArchived: result.tablesArchived,
      message: `Restored to snapshot ${snapshotId}. ${result.tablesRestored.length} tables restored, ${result.tablesArchived.length} tables archived.`,
    })
  } catch (error: any) {
    console.error('[Archives API] Restore error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to restore snapshot' },
      { status: 500 }
    )
  }
}
