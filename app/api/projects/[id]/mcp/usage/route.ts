export const dynamic = 'force-dynamic'

/**
 * GET /api/projects/[id]/mcp/usage
 *
 * Returns activity stats for the project's MCP keys so the dashboard can
 * show "is this actually being used?" data:
 *
 *   - calls24h:    total calls across all MCP keys in this project, last 24h
 *   - calls7d:     same, last 7 days
 *   - errorRate:   ratio of non-2xx / total over the last 24h
 *   - byKey[]:     per-key counts + last activity timestamp
 *   - recent[]:    last 20 calls (endpoint, tool, status, ms, when)
 *
 * Auth: platform JWT via withProjectValidation — owner-only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'

const DAY_MS = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(req, async ({ projectId }) => {
   try {
    const now = new Date()
    const since24h = new Date(now.getTime() - DAY_MS)
    const since7d = new Date(now.getTime() - 7 * DAY_MS)

    // Find every MCP key in this project. We need their ids for the usage join.
    const keys = await prisma.apiKey.findMany({
      where: { projectId, scope: 'mcp' },
      select: { id: true, name: true, mcpClientLabel: true, lastUsed: true, keyPrefix: true },
    })
    const keyIds = keys.map((k) => k.id)

    if (keyIds.length === 0) {
      return NextResponse.json({
        calls24h: 0,
        calls7d: 0,
        errorRate: 0,
        byKey: [],
        recent: [],
      })
    }

    const [count24h, errs24h, count7d, perKey7d, recent] = await Promise.all([
      prisma.apiKeyUsage.count({
        where: { apiKeyId: { in: keyIds }, timestamp: { gte: since24h } },
      }),
      prisma.apiKeyUsage.count({
        where: {
          apiKeyId: { in: keyIds },
          timestamp: { gte: since24h },
          statusCode: { gte: 400 },
        },
      }),
      prisma.apiKeyUsage.count({
        where: { apiKeyId: { in: keyIds }, timestamp: { gte: since7d } },
      }),
      prisma.apiKeyUsage.groupBy({
        by: ['apiKeyId'],
        where: { apiKeyId: { in: keyIds }, timestamp: { gte: since7d } },
        _count: { _all: true },
      }),
      prisma.apiKeyUsage.findMany({
        where: { apiKeyId: { in: keyIds } },
        orderBy: { timestamp: 'desc' },
        take: 20,
        select: {
          id: true,
          apiKeyId: true,
          endpoint: true,
          statusCode: true,
          responseTime: true,
          timestamp: true,
          metadata: true,
        },
      }),
    ])

    const countsByKey = new Map(perKey7d.map((r) => [r.apiKeyId, r._count._all]))

    const byKey = keys.map((k) => ({
      keyId: k.id,
      name: k.name,
      label: k.mcpClientLabel,
      calls7d: countsByKey.get(k.id) ?? 0,
      lastUsed: k.lastUsed,
    }))

    const errorRate = count24h > 0 ? errs24h / count24h : 0

    return NextResponse.json({
      calls24h: count24h,
      calls7d: count7d,
      errorRate,
      byKey,
      recent: recent.map((r) => {
        const md = (r.metadata as any) ?? {}
        return {
          id: r.id,
          keyId: r.apiKeyId,
          endpoint: r.endpoint,
          tool: md.tool ?? null,
          statusCode: r.statusCode,
          ms: r.responseTime,
          summary: md.summary ?? null,
          error: md.error ?? null,
          mutation: !!md.mutation,
          timestamp: r.timestamp,
        }
      }),
    })
   } catch (err) {
      // A Prisma/serialization error must never escape as a framework text
      // 500 (which the dashboard can't JSON-parse). Degrade to empty usage.
      console.error('[mcp/usage] GET failed:', err)
      return NextResponse.json(
        { calls24h: 0, calls7d: 0, errorRate: 0, byKey: [], recent: [] },
        { status: 200 },
      )
   }
  })
}
