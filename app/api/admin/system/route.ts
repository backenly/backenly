export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/system
 *
 * Reliability + cost cockpit for the founder System tab:
 *   - aiCost       OpenAI spend (AiUsage ledger) — 30d + this-month, by model,
 *                  top-cost projects, and margin vs MRR
 *   - metrics      live DB connections, background-job queue depth, 24h errors
 *   - noisyNeighbors top projects by AI cost + write volume (last 7d)
 *   - schemaHealth workspace_* schema sizes + orphans (schema with no live Project)
 *   - deployments  recent deploys with status/errors + failure count
 *
 * FOUNDER-ONLY. Money/cost figures come straight from the AiUsage ledger and
 * Plan prices — nothing fabricated. cost is null on rows the ledger didn't
 * price, so totals are a floor, and the response says so.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const since30d = new Date(now.getTime() - 30 * 86_400_000)
  const since7d = new Date(now.getTime() - 7 * 86_400_000)
  const since24h = new Date(now.getTime() - 86_400_000)

  const [
    cost30Agg, costMonthAgg, costByModel, costByProjectRaw,
    activeSubs, plans,
    jobsByStatus, errorCount24h,
    connRows, schemaRows, liveProjects,
    deployments, failedDeployCount,
  ] = await Promise.all([
    prisma.aiUsage.aggregate({ _sum: { cost: true, totalTokens: true }, where: { createdAt: { gte: since30d } } }),
    prisma.aiUsage.aggregate({ _sum: { cost: true, totalTokens: true }, where: { createdAt: { gte: monthStart } } }),
    prisma.aiUsage.groupBy({ by: ['model'], _sum: { cost: true, totalTokens: true }, where: { createdAt: { gte: since30d } } }),
    prisma.aiUsage.groupBy({ by: ['projectId'], _sum: { cost: true, totalTokens: true }, where: { createdAt: { gte: since7d } }, orderBy: { _sum: { cost: 'desc' } }, take: 10 }),
    prisma.subscription.findMany({ where: { status: { in: ['ACTIVE', 'GRACE'] } }, select: { planId: true } }),
    prisma.plan.findMany({ select: { id: true, priceCents: true } }),
    prisma.backgroundJob.groupBy({ by: ['status'], _count: { id: true } }),
    prisma.log.count({ where: { severity: 'error', createdAt: { gte: since24h } } }).catch(() => 0),
    prisma.$queryRawUnsafe<{ total: number; max: number }[]>(
      `SELECT (SELECT count(*)::int FROM pg_stat_activity) AS total,
              (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS max`,
    ).catch(() => [{ total: 0, max: 0 }]),
    prisma.$queryRawUnsafe<{ schema: string; bytes: string }[]>(
      `SELECT n.nspname AS schema,
              COALESCE(SUM(pg_total_relation_size(c.oid)),0)::bigint AS bytes
       FROM pg_namespace n
       LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','m','t')
       WHERE n.nspname LIKE 'workspace_%'
       GROUP BY n.nspname
       ORDER BY bytes DESC`,
    ).catch(() => []),
    prisma.project.findMany({ where: { deletedAt: null, expiresAt: null }, select: { id: true } }),
    prisma.deployment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, projectId: true, status: true, environment: true, url: true, errorMessage: true, duration: true, createdAt: true },
    }),
    prisma.deployment.count({ where: { status: { in: ['failed', 'error'] }, createdAt: { gte: since7d } } }),
  ])

  // ── AI cost + margin ───────────────────────────────────────────────────────
  const planPrice = new Map(plans.map(p => [p.id, p.priceCents]))
  const mrrCents = activeSubs.reduce((s, x) => s + (planPrice.get(x.planId) ?? 0), 0)
  const cost30 = cost30Agg._sum.cost ?? 0
  const costMonth = costMonthAgg._sum.cost ?? 0
  const marginCents = mrrCents - Math.round(costMonth * 100)

  // top cost projects → resolve names
  const costProjIds = costByProjectRaw.map(r => r.projectId)
  const costProjects = costProjIds.length
    ? await prisma.project.findMany({ where: { id: { in: costProjIds } }, select: { id: true, name: true, userId: true, user: { select: { email: true } } } })
    : []
  const cpMap = new Map(costProjects.map(p => [p.id, p]))

  // ── Schema health ──────────────────────────────────────────────────────────
  const liveIds = new Set(liveProjects.map(p => p.id))
  let totalSchemaBytes = 0
  const schemas = schemaRows.map(r => {
    const bytes = Number(r.bytes)
    totalSchemaBytes += bytes
    const projectId = r.schema.replace(/^workspace_/, '')
    return { schema: r.schema, projectId, bytes, orphaned: !liveIds.has(projectId) }
  })
  const orphanCount = schemas.filter(s => s.orphaned).length

  // ── Noisy neighbours: AI cost + write volume (last 7d) ─────────────────────
  const writeAgg = await prisma.usageMetric.groupBy({
    by: ['projectId'],
    _sum: { dbWrites: true, apiCalls: true },
    where: { createdAt: { gte: since7d }, projectId: { not: null } },
    orderBy: { _sum: { dbWrites: 'desc' } },
    take: 10,
  })
  const writeProjIds = writeAgg.map(w => w.projectId).filter(Boolean) as string[]
  const writeProjects = writeProjIds.length
    ? await prisma.project.findMany({ where: { id: { in: writeProjIds } }, select: { id: true, name: true } })
    : []
  const wpMap = new Map(writeProjects.map(p => [p.id, p.name]))

  return NextResponse.json({
    aiCost: {
      spend30dUsd: Math.round(cost30 * 100) / 100,
      spendMonthUsd: Math.round(costMonth * 100) / 100,
      tokens30d: cost30Agg._sum.totalTokens ?? 0,
      mrrUsd: Math.round(mrrCents) / 100,
      marginUsd: Math.round(marginCents) / 100,
      byModel: costByModel
        .map(m => ({ model: m.model, costUsd: Math.round((m._sum.cost ?? 0) * 100) / 100, tokens: m._sum.totalTokens ?? 0 }))
        .sort((a, b) => b.costUsd - a.costUsd),
      topProjects: costByProjectRaw.map(r => ({
        projectId: r.projectId,
        projectName: cpMap.get(r.projectId)?.name ?? '—',
        ownerEmail: cpMap.get(r.projectId)?.user?.email ?? null,
        ownerUserId: cpMap.get(r.projectId)?.userId ?? null,
        costUsd: Math.round((r._sum.cost ?? 0) * 100) / 100,
        tokens: r._sum.totalTokens ?? 0,
      })),
      note: 'Cost is summed from the AiUsage ledger; rows the ledger did not price are counted as $0, so totals are a floor.',
    },
    metrics: {
      db: { connections: connRows[0]?.total ?? 0, max: connRows[0]?.max ?? 0 },
      jobs: Object.fromEntries(jobsByStatus.map(j => [j.status, j._count.id])),
      errors24h: errorCount24h,
      workspaceSchemas: schemas.length,
    },
    noisyNeighbors: writeAgg.map(w => ({
      projectId: w.projectId,
      projectName: w.projectId ? wpMap.get(w.projectId) ?? '—' : '—',
      dbWrites: w._sum.dbWrites ?? 0,
      apiCalls: w._sum.apiCalls ?? 0,
    })),
    schemaHealth: {
      totalBytes: totalSchemaBytes,
      orphanCount,
      schemas: schemas.slice(0, 40),
    },
    deployments: {
      failed7d: failedDeployCount,
      recent: deployments.map(d => ({
        id: d.id,
        projectId: d.projectId,
        status: d.status,
        environment: d.environment,
        url: d.url,
        errorMessage: d.errorMessage,
        duration: d.duration,
        at: d.createdAt.toISOString(),
      })),
    },
  })
}
