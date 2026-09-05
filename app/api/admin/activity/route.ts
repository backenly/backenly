export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/activity
 *
 * One time-ordered stream merging the three things that actually tell you
 * what is happening on the platform:
 *   - ProductEvent   (signup / project / backend / deploy / ai_prompt …)
 *   - AuditLog        (mutations, admin actions, billing)
 *   - SecurityEvent   (cross-tenant, anomalies, secret leaks …)
 *
 * Query: ?source=all|event|audit|security  &q=<text>  &userId=  &projectId=
 *        &limit=(default 80, max 200)
 *
 * FOUNDER-ONLY.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

interface ActivityItem {
  id: string
  source: 'event' | 'audit' | 'security'
  kind: string
  summary: string
  severity?: string
  userId: string | null
  userEmail: string | null
  projectId: string | null
  projectName: string | null
  ts: string
}

function describeProductEvent(eventType: string, projectName: string | null, metadata: any): string {
  const m = (metadata ?? {}) as Record<string, any>
  const proj = projectName ? `“${projectName}”` : (m.name ? `“${m.name}”` : 'a project')
  switch (eventType) {
    case 'signup': return m.provider ? `Signed up via ${m.provider}` : 'Signed up'
    case 'project_created': return `Created project ${proj}`
    case 'backend_generated': return `Generated a backend for ${proj}`
    case 'frontend_connected': return `Connected a frontend to ${proj}`
    case 'deployed': return `Deployed ${proj}`
    case 'external_usage_started': return `Got first real users on ${proj}`
    case 'ai_prompt': return typeof m.messageLength === 'number' ? `Sent an AI prompt (${m.messageLength} chars)` : 'Sent an AI prompt'
    case 'api_call': return projectName ? `API traffic on ${proj}` : 'API traffic'
    default: return eventType.replace(/_/g, ' ')
  }
}

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const sp = request.nextUrl.searchParams
  const source = sp.get('source') ?? 'all'
  const q = (sp.get('q') ?? '').trim()
  const userId = sp.get('userId') || undefined
  const projectId = sp.get('projectId') || undefined
  const limit = Math.min(parseInt(sp.get('limit') ?? '80'), 200)

  const wantEvent = source === 'all' || source === 'event'
  const wantAudit = source === 'all' || source === 'audit'
  const wantSecurity = source === 'all' || source === 'security'

  const [events, audits, secs] = await Promise.all([
    wantEvent
      ? prisma.productEvent.findMany({
          where: {
            ...(userId ? { userId } : {}),
            ...(projectId ? { projectId } : {}),
            ...(q ? { eventType: { contains: q, mode: 'insensitive' } } : {}),
          },
          orderBy: { timestamp: 'desc' },
          take: limit,
          select: { id: true, eventType: true, userId: true, projectId: true, timestamp: true, metadata: true },
        })
      : Promise.resolve([]),
    wantAudit
      ? prisma.auditLog.findMany({
          where: {
            ...(userId ? { userId } : {}),
            ...(projectId ? { projectId } : {}),
            ...(q ? { OR: [{ action: { contains: q, mode: 'insensitive' } }, { details: { contains: q, mode: 'insensitive' } }] } : {}),
          },
          orderBy: { timestamp: 'desc' },
          take: limit,
          select: { id: true, action: true, type: true, details: true, userId: true, userEmail: true, projectId: true, timestamp: true },
        })
      : Promise.resolve([]),
    wantSecurity
      ? prisma.securityEvent.findMany({
          where: {
            ...(userId ? { userId } : {}),
            ...(projectId ? { projectId } : {}),
            ...(q ? { OR: [{ summary: { contains: q, mode: 'insensitive' } }, { kind: { contains: q, mode: 'insensitive' } }] } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: { id: true, kind: true, severity: true, summary: true, userId: true, userEmail: true, projectId: true, createdAt: true },
        })
      : Promise.resolve([]),
  ])

  // Resolve names for the union of referenced ids.
  const projIds = [...new Set([
    ...events.map(e => e.projectId),
    ...audits.map(a => a.projectId),
    ...secs.map(s => s.projectId),
  ].filter(Boolean) as string[])]
  const userIds = [...new Set([
    ...events.map(e => e.userId),
    ...audits.map(a => a.userId),
    ...secs.map(s => s.userId),
  ].filter(Boolean) as string[])]

  const [projRows, userRows] = await Promise.all([
    projIds.length ? prisma.project.findMany({ where: { id: { in: projIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : Promise.resolve([]),
  ])
  const projName = new Map(projRows.map(p => [p.id, p.name]))
  const userEmail = new Map(userRows.map(u => [u.id, u.email]))

  const items: ActivityItem[] = []

  for (const e of events) {
    const pName = e.projectId ? projName.get(e.projectId) ?? null : null
    items.push({
      id: `ev_${e.id}`,
      source: 'event',
      kind: e.eventType,
      summary: describeProductEvent(e.eventType, pName, e.metadata),
      userId: e.userId,
      userEmail: e.userId ? userEmail.get(e.userId) ?? null : null,
      projectId: e.projectId,
      projectName: pName,
      ts: e.timestamp.toISOString(),
    })
  }
  for (const a of audits) {
    items.push({
      id: `au_${a.id}`,
      source: 'audit',
      kind: a.action,
      summary: a.details || a.action,
      userId: a.userId,
      userEmail: a.userEmail ?? (a.userId ? userEmail.get(a.userId) ?? null : null),
      projectId: a.projectId,
      projectName: a.projectId ? projName.get(a.projectId) ?? null : null,
      ts: a.timestamp.toISOString(),
    })
  }
  for (const s of secs) {
    items.push({
      id: `se_${s.id}`,
      source: 'security',
      kind: s.kind,
      summary: s.summary,
      severity: s.severity,
      userId: s.userId,
      userEmail: s.userEmail ?? (s.userId ? userEmail.get(s.userId) ?? null : null),
      projectId: s.projectId,
      projectName: s.projectId ? projName.get(s.projectId) ?? null : null,
      ts: s.createdAt.toISOString(),
    })
  }

  items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())

  return NextResponse.json({ items: items.slice(0, limit), shown: Math.min(items.length, limit) })
}
