export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/admin/analytics
 *
 * Returns funnel overview + summary stats for the Founder Dashboard.
 * FOUNDER-ONLY — enforced server-side.
 */
export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const [
    totalUsers,
    usersWithProject,
    usersWithBackend,
    usersWithFrontend,
    usersWithDeploy,
    usersWithExternal,
    totalProjects,
    totalAiCalls,
    recentEvents,
  ] = await Promise.all([
    // Total platform users
    prisma.user.count({ where: { deletedAt: null } }),

    // Users who created ≥1 project
    prisma.user.count({
      where: {
        deletedAt: null,
        projects: { some: {} },
      },
    }),

    // Users who generated a backend
    prisma.user.count({
      where: {
        deletedAt: null,
        projects: { some: { isBackendGenerated: true } },
      },
    }),

    // Users who connected a frontend
    prisma.user.count({
      where: {
        deletedAt: null,
        projects: { some: { isFrontendConnected: true } },
      },
    }),

    // Users who deployed
    prisma.user.count({
      where: {
        deletedAt: null,
        projects: { some: { isDeployed: true } },
      },
    }),

    // Users with real external users
    prisma.user.count({
      where: {
        deletedAt: null,
        projects: { some: { hasExternalUsers: true } },
      },
    }),

    prisma.project.count({ where: { expiresAt: null } }),

    // Sum of AI calls from usage metrics
    prisma.usageMetric.aggregate({ _sum: { aiCalls: true } }),

    // Most recent 10 events
    prisma.productEvent.findMany({
      orderBy: { timestamp: 'desc' },
      take: 10,
      select: {
        id: true,
        eventType: true,
        userId: true,
        projectId: true,
        timestamp: true,
        metadata: true,
      },
    }),
  ])

  const funnel = [
    { stage: 'Signup', count: totalUsers },
    { stage: 'Create Project', count: usersWithProject },
    { stage: 'Generate Backend', count: usersWithBackend },
    { stage: 'Connect Frontend', count: usersWithFrontend },
    { stage: 'Deploy', count: usersWithDeploy },
    { stage: 'Get Real Users', count: usersWithExternal },
  ]

  // ── Enrich events with project name + actor so the feed is human-readable.
  // logEvent() records projectId + metadata but the raw rows are meaningless
  // on their own ("backend_generated" by which user, for which project?).
  const evProjectIds = [...new Set(recentEvents.map(e => e.projectId).filter(Boolean))] as string[]
  const evUserIds = [...new Set(recentEvents.map(e => e.userId).filter(Boolean))]

  const [evProjects, evUsers] = await Promise.all([
    evProjectIds.length
      ? prisma.project.findMany({ where: { id: { in: evProjectIds } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: string; name: string }[]),
    evUserIds.length
      ? prisma.user.findMany({ where: { id: { in: evUserIds } }, select: { id: true, email: true, name: true } })
      : Promise.resolve([] as { id: string; email: string; name: string | null }[]),
  ])

  const projName = new Map(evProjects.map(p => [p.id, p.name]))
  const userInfo = new Map(evUsers.map(u => [u.id, u]))

  const enrichedEvents = recentEvents.map(e => ({
    ...e,
    projectName: e.projectId ? projName.get(e.projectId) ?? null : null,
    userEmail: userInfo.get(e.userId)?.email ?? null,
    userName: userInfo.get(e.userId)?.name ?? null,
  }))

  return NextResponse.json({
    funnel,
    totalUsers,
    totalProjects,
    totalAiCalls: totalAiCalls._sum.aiCalls ?? 0,
    recentEvents: enrichedEvents,
  })
}
