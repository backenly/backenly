export const dynamic = 'force-dynamic'

/**
 * GET  /api/admin/security        → security feed + rollup for the Security tab
 *   ?kind=cross_tenant|auth_anomaly|suspicious_prompt|secret_leak|api_abuse|...
 *   ?severity=info|warn|high|critical
 *   ?resolved=true|false
 *   ?limit (default 100, max 300)
 *
 * POST /api/admin/security        → { id, resolved: true } mark an event handled
 *
 * FOUNDER-ONLY. Reads the SecurityEvent table populated by the instrumentation
 * added across auth / tenant-isolation / v1-runtime / AI routes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/prisma'

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const sp = request.nextUrl.searchParams
  const kind = sp.get('kind')
  const severity = sp.get('severity')
  const resolvedParam = sp.get('resolved')
  const limit = Math.min(parseInt(sp.get('limit') ?? '100'), 300)

  const where: any = {}
  if (kind) where.kind = kind
  if (severity) where.severity = severity
  if (resolvedParam === 'true') where.resolved = true
  if (resolvedParam === 'false') where.resolved = false

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [events, total, unresolved, last24h, byKind, bySeverity, topIps] = await Promise.all([
    prisma.securityEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.securityEvent.count(),
    prisma.securityEvent.count({ where: { resolved: false } }),
    prisma.securityEvent.count({ where: { createdAt: { gte: since24h } } }),
    prisma.securityEvent.groupBy({
      by: ['kind'],
      _count: { id: true },
      where: { createdAt: { gte: since7d } },
    }),
    prisma.securityEvent.groupBy({
      by: ['severity'],
      _count: { id: true },
      where: { resolved: false },
    }),
    // Worst offending IPs in the last 7 days (auth brute force, abuse, probes)
    prisma.securityEvent.groupBy({
      by: ['ip'],
      _count: { id: true },
      where: { createdAt: { gte: since7d }, ip: { not: null } },
      orderBy: { _count: { id: 'desc' } },
      take: 8,
    }),
  ])

  return NextResponse.json({
    events,
    summary: {
      total,
      unresolved,
      last24h,
      byKind: Object.fromEntries(byKind.map(k => [k.kind, k._count.id])),
      bySeverity: Object.fromEntries(bySeverity.map(s => [s.severity, s._count.id])),
      topIps: topIps
        .filter(t => t.ip)
        .map(t => ({ ip: t.ip as string, count: t._count.id })),
    },
  })
}

export async function POST(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any = {}
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { id, resolved } = body
  if (!id || typeof resolved !== 'boolean') {
    return NextResponse.json({ error: 'id and resolved (boolean) are required' }, { status: 400 })
  }

  const existing = await prisma.securityEvent.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updated = await prisma.securityEvent.update({
    where: { id },
    data: {
      resolved,
      resolvedAt: resolved ? new Date() : null,
      resolvedBy: resolved ? auth.userEmail : null,
    },
  })

  return NextResponse.json({ event: updated })
}
