/**
 * GET  /api/projects/{id}/autonomous-actions          — list autonomous actions (default: unseen only)
 * POST /api/projects/{id}/autonomous-actions/mark-seen — mark all as seen
 *
 * Called when a developer opens a project to surface the "while you were away" banner.
 * The banner shows: "Backenly applied 3 fixes and found 2 items needing your review."
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { verifySession } from '@/lib/auth/session'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const token = request.cookies.get('auth-token')?.value
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const session = await verifySession(token)
    if (!session.valid || !session.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const projectId = params.id
    const unseenOnly = request.nextUrl.searchParams.get('unseen') !== 'false'

    // Verify project ownership
    if (!(await canAccessProject(session.userId, projectId))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const actions = await prisma.autonomousAction.findMany({
      where: {
        projectId,
        ...(unseenOnly ? { seenByUser: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        appliedFixes: true,
        pendingReview: true,
        seenByUser: true,
        createdAt: true,
      },
    })

    // Aggregate totals for the banner
    const totalApplied = actions.reduce((sum, a) => {
      const fixes = Array.isArray(a.appliedFixes) ? a.appliedFixes : []
      return sum + fixes.length
    }, 0)
    const totalPending = actions.reduce((sum, a) => {
      const pending = Array.isArray(a.pendingReview) ? a.pendingReview : []
      return sum + pending.length
    }, 0)

    return NextResponse.json({
      actions,
      summary: {
        total: actions.length,
        totalApplied,
        totalPending,
        hasUnseen: actions.some(a => !a.seenByUser),
      },
    })
  } catch (err) {
    console.error('[AutonomousActions] GET failed:', err)
    return NextResponse.json({ error: 'Failed to load autonomous actions' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const token = request.cookies.get('auth-token')?.value
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const session = await verifySession(token)
    if (!session.valid || !session.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const projectId = params.id

    // Verify project ownership
    if (!(await canWriteProject(session.userId, projectId))) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Mark all unseen actions as seen
    const result = await prisma.autonomousAction.updateMany({
      where: { projectId, seenByUser: false },
      data: { seenByUser: true, seenAt: new Date() },
    })

    return NextResponse.json({ marked: result.count })
  } catch (err) {
    console.error('[AutonomousActions] PATCH failed:', err)
    return NextResponse.json({ error: 'Failed to mark actions as seen' }, { status: 500 })
  }
}
