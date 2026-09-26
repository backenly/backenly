/**
 * Reads the evidence the Getting Started guide derives its steps from.
 *
 * Server only. Every query is scoped two ways: to the projects the caller can
 * see (the list comes from ProjectLifecycle, the one authority on that), and,
 * for credentials, to keys the caller minted. Nothing here returns key
 * material: counts and timestamps, plus the stored call summary, which
 * lib/mcp/guard.ts already wrote with secrets withheld.
 */

import { prisma } from '@/lib/db/prisma'
import { builtEvidenceWhere } from '@/lib/projects/backend-presence'
import { getLastLoopTickAt } from '@/lib/autonomy/loop-tick'
import type { GuideFacts, McpCallFact, ProjectFact } from './guide'

/**
 * Projects the guide reads facts for, newest first. A guide is for someone's
 * first backends; an account with more than this has long since finished it,
 * and the bound keeps a reopened guide cheap on a large one.
 */
export const GUIDE_PROJECT_LIMIT = 25

/** Autonomy clocks are read one project at a time, so they get a tighter bound. */
const CHECKED_PROJECT_LIMIT = 5

export interface VisibleProject {
  id: string
  name: string
  createdAt: Date
  projectStatus: string
  deployedAt: Date | null
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)

export async function collectGuideFacts(userId: string, visible: VisibleProject[]): Promise<GuideFacts> {
  const projects = [...visible]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, GUIDE_PROJECT_LIMIT)
  const ids = projects.map((p) => p.id)
  if (ids.length === 0) return { projects: [], lastCall: null }

  const [details, built, credentials] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: ids } },
      select: { id: true, deploymentError: true, lastObservedAt: true },
    }),
    prisma.project.findMany({
      where: { AND: [{ id: { in: ids } }, builtEvidenceWhere()] },
      select: { id: true },
    }),
    // OAuth connections are ApiKey rows too (keyType 'mcp_oauth'); both kinds
    // carry the agent's traffic, so both count as a way in.
    prisma.apiKey.findMany({
      where: { userId, scope: 'mcp', projectId: { in: ids } },
      select: { id: true, projectId: true, keyType: true },
    }),
  ])

  const credentialIds = credentials.map((c) => c.id)
  const projectOfCredential = new Map(credentials.map((c) => [c.id, c.projectId]))

  const [lastSuccessByCredential, latestCall] = credentialIds.length
    ? await Promise.all([
        prisma.apiKeyUsage.groupBy({
          by: ['apiKeyId'],
          where: { apiKeyId: { in: credentialIds }, statusCode: { lt: 400 } },
          _max: { timestamp: true },
        }),
        prisma.apiKeyUsage.findFirst({
          where: { apiKeyId: { in: credentialIds } },
          orderBy: { timestamp: 'desc' },
          select: { endpoint: true, statusCode: true, timestamp: true, metadata: true },
        }),
      ])
    : [[], null]

  const lastAgentCall = new Map<string, Date>()
  for (const row of lastSuccessByCredential) {
    const projectId = projectOfCredential.get(row.apiKeyId)
    const at = row._max.timestamp
    if (!projectId || !at) continue
    const prev = lastAgentCall.get(projectId)
    if (!prev || at > prev) lastAgentCall.set(projectId, at)
  }

  const builtIds = new Set(built.map((b) => b.id))
  const detailById = new Map(details.map((d) => [d.id, d]))

  // The loop's own clock, for the few built projects a guide can be about.
  const checkedIds = projects.filter((p) => builtIds.has(p.id)).slice(0, CHECKED_PROJECT_LIMIT).map((p) => p.id)
  const ticks = await Promise.all(checkedIds.map((id) => getLastLoopTickAt(id)))
  const tickById = new Map(checkedIds.map((id, i) => [id, ticks[i]]))

  const facts: ProjectFact[] = projects.map((p) => {
    const detail = detailById.get(p.id)
    const tick = tickById.get(p.id) ?? null
    const observed = detail?.lastObservedAt ?? null
    const lastChecked = tick && observed ? (tick > observed ? tick : observed) : tick ?? observed
    const own = credentials.filter((c) => c.projectId === p.id)
    return {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt.toISOString(),
      status: p.projectStatus,
      deployedAt: iso(p.deployedAt),
      deploymentError: detail?.deploymentError ?? null,
      mcpKeys: own.filter((c) => c.keyType !== 'mcp_oauth').length,
      oauthConnections: own.filter((c) => c.keyType === 'mcp_oauth').length,
      lastAgentCallAt: iso(lastAgentCall.get(p.id)),
      built: builtIds.has(p.id),
      lastCheckedAt: builtIds.has(p.id) ? iso(lastChecked) : null,
    }
  })

  return { projects: facts, lastCall: latestCall ? toCallFact(latestCall) : null }
}

function toCallFact(row: { endpoint: string; statusCode: number; timestamp: Date; metadata: unknown }): McpCallFact {
  const md = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : null)
  return {
    tool: text(md.tool),
    endpoint: row.endpoint,
    statusCode: row.statusCode,
    at: row.timestamp.toISOString(),
    error: text(md.error),
  }
}
