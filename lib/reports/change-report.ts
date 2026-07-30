/**
 * Change report — the shareable trust artifact.
 *
 * Assembles a read-only snapshot of "what changed and that nothing broke":
 * backend shape (tables/endpoints/functions), 30-day change metrics computed
 * from AuditLog (the same source History reads), and the plain-English
 * activity ledger. Rendered publicly at /report/[token] for whoever the owner
 * shares the link with — a client, a cofounder, an investor.
 *
 * Contains NOTHING sensitive by construction: no keys, no env vars, no
 * end-user emails, no SQL — feed labels are already the non-technical
 * sentences lib/activity/feed.ts produces.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { buildActivityFeed } from '@/lib/activity/feed'
import { countExposedResources } from '@/lib/api/exposed-resources'

export interface ChangeReport {
  project: { name: string }
  generatedAt: string
  counts: { tables: number; endpoints: number; functions: number }
  metrics: {
    windowDays: number
    autoFixes: number
    approvedChanges: number
    rollbacks: number
    agentChanges: number
  }
  feed: Array<{ label: string; ts: string }>
}

export function hashShareToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function newShareToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export async function buildChangeReport(projectId: string): Promise<ChangeReport | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  })
  if (!project) return null

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const [tables, endpoints, functions, autoFixes, approved, rollbacks, agentChanges, feed] =
    await Promise.all([
      prisma.table.count({ where: { projectId } }),
      countExposedResources(projectId),
      prisma.aiFunction.count({ where: { projectId } }),
      prisma.auditLog.count({
        where: { projectId, timestamp: { gte: since }, action: { contains: 'AUTO_FIXED' } },
      }),
      prisma.auditLog.count({
        where: { projectId, timestamp: { gte: since }, action: { contains: 'APPROV' } },
      }),
      prisma.auditLog.count({
        where: { projectId, timestamp: { gte: since }, action: { contains: 'ROLLED_BACK' } },
      }),
      prisma.auditLog.count({
        where: { projectId, timestamp: { gte: since }, type: 'mcp' },
      }),
      buildActivityFeed(projectId, { limit: 60 }),
    ])

  return {
    project: { name: project.name },
    generatedAt: new Date().toISOString(),
    counts: { tables, endpoints, functions },
    metrics: {
      windowDays: 30,
      autoFixes,
      approvedChanges: approved,
      rollbacks,
      agentChanges,
    },
    feed: feed.rows.map((r) => ({ label: r.label, ts: r.ts })),
  }
}

/** Resolve a raw share token to its project — null when missing or revoked. */
export async function resolveShareToken(rawToken: string): Promise<{ projectId: string; tokenId: string } | null> {
  if (!rawToken || rawToken.length < 16 || rawToken.length > 128) return null
  const row = await prisma.shareToken.findUnique({
    where: { tokenHash: hashShareToken(rawToken) },
    select: { id: true, projectId: true, revokedAt: true },
  })
  if (!row || row.revokedAt) return null
  prisma.shareToken
    .update({ where: { id: row.id }, data: { lastViewedAt: new Date() } })
    .catch(() => {})
  return { projectId: row.projectId, tokenId: row.id }
}
