export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/feedback
 *
 * The founder's roadmap signal:
 *   - unsupported     what users asked the AI for that Backenly doesn't do
 *                     (recent list + counts by category)
 *   - categoryTrends  what users are building, by month (from BackendGraph)
 *   - churn           canceled / past-due subscriptions with how long they
 *                     were paying. NOTE: no cancellation survey exists yet, so
 *                     there is no "reason" field — this is the honest, derivable
 *                     churn list, not a fabricated reasons breakdown.
 *   - supportTickets  user-submitted in-app support requests (Settings → Contact support)
 *   - featureRequests user-submitted in-app feature requests (Settings → Request a feature)
 *
 * FOUNDER-ONLY.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

// Same heuristic as /api/admin/insights so categories are consistent.
function extractBackendCategory(graphData: any): string {
  try {
    const tables: string[] = []
    if (Array.isArray(graphData?.tables)) {
      tables.push(...graphData.tables.map((t: any) => (t.name || t.tableName || '').toLowerCase()))
    }
    if (typeof graphData === 'object' && graphData !== null) {
      for (const key of Object.keys(graphData)) {
        if (typeof graphData[key] === 'string') tables.push(graphData[key].toLowerCase())
      }
    }
    const c = tables.join(' ')
    if (/product|cart|order|inventory|sku/.test(c)) return 'E-commerce'
    if (/post|comment|like|follow|feed/.test(c)) return 'Social'
    if (/subscription|tenant|workspace|plan/.test(c)) return 'SaaS'
    if (/article|blog|cms|draft|publish/.test(c)) return 'Blog / CMS'
    if (/task|todo|board|issue|ticket/.test(c)) return 'Task Mgmt'
    if (/booking|appointment|slot|schedule/.test(c)) return 'Booking'
    if (/message|chat|conversation|inbox/.test(c)) return 'Messaging'
    if (/file|upload|storage|media/.test(c)) return 'File Storage'
    if (/metric|analytic|stat|report/.test(c)) return 'Analytics'
    if (/user|profile|auth|account/.test(c)) return 'Auth / Users'
  } catch { /* ignore */ }
  return 'General'
}

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

  const [recentUnsupported, unsupportedByCat, graphs, churned, tickets, featureReqs] = await Promise.all([
    prisma.unsupportedRequest.findMany({
      orderBy: { createdAt: 'desc' },
      take: 60,
    }),
    prisma.unsupportedRequest.groupBy({
      by: ['category'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    }),
    prisma.backendGraph.findMany({
      where: { createdAt: { gte: since90d } },
      orderBy: { createdAt: 'asc' },
      take: 1000,
      select: { graphData: true, createdAt: true },
    }),
    prisma.subscription.findMany({
      where: { status: { in: ['CANCELED', 'PAST_DUE'] } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        user: { select: { id: true, email: true, name: true } },
        plan: { select: { name: true, priceCents: true } },
      },
    }),
    prisma.supportTicket.findMany({
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: { user: { select: { id: true, email: true, name: true } } },
    }),
    prisma.featureRequest.findMany({
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: { user: { select: { id: true, email: true, name: true } } },
    }),
  ])

  // Resolve user emails for the unsupported list.
  const uReqUserIds = [...new Set(recentUnsupported.map(r => r.userId).filter(Boolean) as string[])]
  const uReqProjIds = [...new Set(recentUnsupported.map(r => r.projectId).filter(Boolean) as string[])]
  const [uUsers, uProjects] = await Promise.all([
    uReqUserIds.length ? prisma.user.findMany({ where: { id: { in: uReqUserIds } }, select: { id: true, email: true } }) : Promise.resolve([]),
    uReqProjIds.length ? prisma.project.findMany({ where: { id: { in: uReqProjIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])
  const uEmail = new Map(uUsers.map(u => [u.id, u.email]))
  const uProjName = new Map(uProjects.map(p => [p.id, p.name]))

  const unsupported = recentUnsupported.map(r => ({
    id: r.id,
    category: r.category,
    promptExcerpt: r.promptExcerpt,
    refusalMessage: r.refusalMessage,
    userEmail: r.userId ? uEmail.get(r.userId) ?? null : null,
    projectName: r.projectId ? uProjName.get(r.projectId) ?? null : null,
    at: r.createdAt.toISOString(),
  }))

  // ── Category trends by month ───────────────────────────────────────────────
  // months: { '2026-03': { 'SaaS': 4, 'Social': 2, … }, … }
  const monthMap = new Map<string, Record<string, number>>()
  const categoryTotals: Record<string, number> = {}
  for (const g of graphs) {
    const month = g.createdAt.toISOString().slice(0, 7)
    const cat = extractBackendCategory(g.graphData)
    const bucket = monthMap.get(month) ?? {}
    bucket[cat] = (bucket[cat] ?? 0) + 1
    monthMap.set(month, bucket)
    categoryTotals[cat] = (categoryTotals[cat] ?? 0) + 1
  }
  const categoryTrends = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, cats]) => ({ month, categories: cats, total: Object.values(cats).reduce((s, n) => s + n, 0) }))
  const topCategories = Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }))

  // ── Churn ──────────────────────────────────────────────────────────────────
  const churn = churned.map(s => ({
    userId: s.user.id,
    userEmail: s.user.email,
    userName: s.user.name,
    plan: s.plan?.name ?? '—',
    priceCents: s.plan?.priceCents ?? 0,
    status: s.status,
    startedAt: s.createdAt.toISOString(),
    endedAt: s.updatedAt.toISOString(),
    daysActive: Math.max(0, Math.round((s.updatedAt.getTime() - s.createdAt.getTime()) / 86_400_000)),
  }))

  const supportTickets = tickets.map(t => ({
    id: t.id,
    subject: t.subject,
    message: t.message,
    status: t.status,
    userId: t.user.id,
    userEmail: t.user.email,
    userName: t.user.name,
    createdAt: t.createdAt.toISOString(),
  }))

  const featureRequests = featureReqs.map(f => ({
    id: f.id,
    title: f.title,
    body: f.body,
    status: f.status,
    userId: f.user.id,
    userEmail: f.user.email,
    userName: f.user.name,
    createdAt: f.createdAt.toISOString(),
  }))

  return NextResponse.json({
    unsupported,
    unsupportedByCategory: unsupportedByCat.map(c => ({ category: c.category, count: c._count.id })),
    categoryTrends,
    topCategories,
    churn,
    churnNote: 'No cancellation survey is collected yet — this is the derivable churn list, not reason analysis.',
    supportTickets,
    featureRequests,
  })
}
