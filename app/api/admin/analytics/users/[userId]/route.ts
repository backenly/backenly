export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/admin/analytics/users/[userId]
 *
 * Returns full detail for a single user: projects, funnel status, usage.
 * FOUNDER-ONLY.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const { userId } = params

  const [user, projects, usage, events, auditTrail, securityTrail] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        lastLogin: true,
        lastActiveAt: true,
        tier: true,
        provider: true,
      },
    }),

    prisma.project.findMany({
      where: { userId, expiresAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        isBackendGenerated: true,
        isFrontendConnected: true,
        isDeployed: true,
        hasExternalUsers: true,
        publicUrl: true,
        projectStatus: true,
        apiRequests: true,
        storageUsed: true,
        activeUsers: true,
      },
    }),

    prisma.usageMetric.groupBy({
      by: ['userId'],
      where: { userId },
      _sum: {
        apiCalls: true,
        dbReads: true,
        dbWrites: true,
        aiCalls: true,
        computeTime: true,
        storageUsed: true,
      },
    }),

    prisma.productEvent.findMany({
      where: { userId },
      orderBy: { timestamp: 'desc' },
      take: 20,
      select: {
        id: true,
        eventType: true,
        projectId: true,
        timestamp: true,
        metadata: true,
      },
    }),

    // Per-user timeline extras: this user's recent audit + security trail.
    prisma.auditLog.findMany({
      where: { userId },
      orderBy: { timestamp: 'desc' },
      take: 20,
      select: { id: true, action: true, type: true, details: true, projectId: true, timestamp: true },
    }),
    prisma.securityEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, kind: true, severity: true, summary: true, projectId: true, createdAt: true },
    }),
  ])

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const rawSum = usage[0]?._sum
  const usageSummary = {
    apiCalls: rawSum?.apiCalls ?? 0,
    dbReads: rawSum?.dbReads ?? 0,
    dbWrites: rawSum?.dbWrites ?? 0,
    aiCalls: rawSum?.aiCalls ?? 0,
    computeTime: rawSum?.computeTime ?? 0,
    storageUsed: Number(rawSum?.storageUsed ?? 0),
  }

  // Serialize BigInt fields in projects
  const safeProjects = projects.map((p) => ({
    ...p,
    storageUsed: Number(p.storageUsed),
  }))

  // Resolve project names for the event history. Events reference projectId
  // but the raw type ("deployed") is meaningless without knowing which project.
  // The user's own projects cover most; fetch any others (e.g. since-deleted).
  const localNames = new Map(projects.map((p) => [p.id, p.name]))
  const missingProjectIds = [
    ...new Set(
      events
        .map((e) => e.projectId)
        .filter((id): id is string => !!id && !localNames.has(id))
    ),
  ]
  if (missingProjectIds.length) {
    const extra = await prisma.project.findMany({
      where: { id: { in: missingProjectIds } },
      select: { id: true, name: true },
    })
    for (const p of extra) localNames.set(p.id, p.name)
  }

  const enrichedEvents = events.map((e) => ({
    ...e,
    projectName: e.projectId ? localNames.get(e.projectId) ?? null : null,
  }))

  // Merge product events + audit + security into one chronological timeline.
  type TL = { id: string; source: 'event' | 'audit' | 'security'; kind: string; summary: string; severity?: string; projectId: string | null; ts: string }
  const timeline: TL[] = [
    ...enrichedEvents.map((e): TL => ({
      id: `ev_${e.id}`, source: 'event', kind: e.eventType,
      summary: e.eventType.replace(/_/g, ' '), projectId: e.projectId, ts: e.timestamp.toISOString(),
    })),
    ...auditTrail.map((a): TL => ({
      id: `au_${a.id}`, source: 'audit', kind: a.action,
      summary: a.details || a.action, projectId: a.projectId, ts: a.timestamp.toISOString(),
    })),
    ...securityTrail.map((s): TL => ({
      id: `se_${s.id}`, source: 'security', kind: s.kind,
      summary: s.summary, severity: s.severity, projectId: s.projectId, ts: s.createdAt.toISOString(),
    })),
  ].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, 40)

  return NextResponse.json({
    user,
    projects: safeProjects,
    usage: usageSummary,
    recentEvents: enrichedEvents,
    timeline,
  })
}
