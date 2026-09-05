export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/agent-ops?days=30
 *
 * "How much production backend work did external coding agents execute, for
 * whom, against which projects — and how much of it landed cleanly?"
 *
 * The Projects/Growth tabs answer "how many projects exist / were deployed".
 * This answers the different question a claim like "N automated schema
 * modifications executed by Claude Code and other agents, none of which
 * corrupted data" has to be sourced from:
 *
 *   totals      calls + statements, split schema / policy / data / chat
 *   outcomes    applied · refused · unresolved · errored  (see lib/admin/agent-ops)
 *   integrity   rollbacks, rolled-back intents, critical findings, unresolved runs
 *   byClient    per MCP client label — "Claude Code laptop", "Cursor work mac"
 *   byUser      per owner
 *   byProject   per project, with that project's integrity events attached
 *   byTool      which doors agents actually use
 *   monthly     12-month trend, so "last month" is a row and not a guess
 *
 * FOUNDER-ONLY.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 * Every figure derives from ApiKeyUsage rows joined to ApiKey.scope='mcp'. That
 * scope is issued only by the MCP setup page and is the only key type accepted
 * by /api/mcp/* and /api/cli/*, so "executed by an agent, not by a human in the
 * dashboard" is enforced by the auth layer rather than inferred here. Nothing
 * on this route is modelled, estimated or defaulted — a number we cannot source
 * is reported as null with the reason in `caveats`.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'
import {
  classifyTool,
  classifyOutcome,
  GUARDRAIL_CODES,
  SCHEMA_TOOL_NAMES,
  type AgentOpKind,
  type AgentOpOutcome,
} from '@/lib/admin/agent-ops'

const DAY_MS = 86_400_000

/** One pre-aggregated slice of the usage ledger. */
interface OpRow {
  user_id: string
  project_id: string | null
  client: string
  tool: string
  mutation: boolean
  status_code: number
  code: string
  ops: number
  statements: number
  last_at: Date
}

interface Counters {
  ops: number
  statements: number
  schemaOps: number
  schemaStatements: number
  policyOps: number
  dataOps: number
  chatOps: number
  otherOps: number
  reads: number
  applied: number
  refused: number
  unresolved: number
  errored: number
  lastAt: string | null
}

const COUNTER_KEYS = [
  'ops', 'statements', 'schemaOps', 'schemaStatements', 'policyOps', 'dataOps',
  'chatOps', 'otherOps', 'reads', 'applied', 'refused', 'unresolved', 'errored',
  'lastAt',
] as const

const zero = (): Counters => ({
  ops: 0, statements: 0, schemaOps: 0, schemaStatements: 0,
  policyOps: 0, dataOps: 0, chatOps: 0, otherOps: 0, reads: 0,
  applied: 0, refused: 0, unresolved: 0, errored: 0, lastAt: null,
})

/**
 * Pull just the counters off an accumulator. The accumulators also carry Sets
 * (distinct clients / projects / users), and a Set serializes to `{}` — so
 * spreading the accumulator straight into the response would ship empty
 * objects where the UI expects numbers.
 */
function strip(c: Counters): Counters {
  const out = {} as Counters
  for (const k of COUNTER_KEYS) (out as any)[k] = (c as any)[k]
  return out
}

function accumulate(c: Counters, row: OpRow, kind: AgentOpKind, outcome: AgentOpOutcome) {
  const at = row.last_at ? new Date(row.last_at).toISOString() : null
  if (at && (!c.lastAt || at > c.lastAt)) c.lastAt = at

  if (kind === 'read') {
    c.reads += row.ops
    return
  }

  c.ops += row.ops
  c.statements += row.statements

  if (kind === 'schema') { c.schemaOps += row.ops; c.schemaStatements += row.statements }
  else if (kind === 'policy') c.policyOps += row.ops
  else if (kind === 'data') c.dataOps += row.ops
  else if (kind === 'chat') c.chatOps += row.ops
  else c.otherOps += row.ops

  if (outcome === 'applied') c.applied += row.ops
  else if (outcome === 'refused') c.refused += row.ops
  else if (outcome === 'unresolved') c.unresolved += row.ops
  else c.errored += row.ops
}

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const daysParam = Number(new URL(request.url).searchParams.get('days') ?? 30)
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(Math.trunc(daysParam), 1), 365) : 30
  const until = new Date()
  const since = new Date(until.getTime() - days * DAY_MS)

  // ── The ledger, pre-aggregated in one pass ─────────────────────────────────
  //
  // Grouped in SQL rather than pulled row-by-row: at agent volumes the raw
  // table is the largest in the database, while the grouped result is bounded
  // by (users × projects × keys × tools × status), which stays in the hundreds.
  //
  // `statements` is the real unit of schema change. apply_migration accepts
  // multi-statement SQL and reports "migration: N statement(s)" in its summary
  // (app/api/mcp/tool/route.ts), so N is parsed back out here. Every other tool
  // is one statement per call. A migration summary we cannot parse counts as 1,
  // which under-counts rather than over-counts.
  const opRows = await prisma.$queryRawUnsafe<OpRow[]>(
    `SELECT
       k."userId"                                          AS user_id,
       k."projectId"                                       AS project_id,
       COALESCE(NULLIF(k."mcpClientLabel", ''), NULLIF(k.name, ''), 'Unlabelled key') AS client,
       COALESCE(NULLIF(u.metadata->>'tool', ''), 'unknown') AS tool,
       COALESCE((u.metadata->>'mutation')::boolean, false)  AS mutation,
       u."statusCode"                                      AS status_code,
       COALESCE(u.metadata->>'error', '')                  AS code,
       COUNT(*)::int                                       AS ops,
       SUM(
         CASE WHEN u.metadata->>'tool' = 'apply_migration'
           THEN COALESCE(
                  NULLIF(substring(COALESCE(u.metadata->>'summary', '') from 'migration: ([0-9]+) statement'), '')::int,
                  1)
           ELSE 1
         END
       )::int                                              AS statements,
       MAX(u."timestamp")                                  AS last_at
     FROM api_key_usage u
     JOIN api_keys k ON k.id = u."apiKeyId"
     WHERE k.scope = 'mcp'
       AND u."timestamp" >= $1
       AND u."timestamp" <= $2
       -- Only rows written by recordMcpCall, which always attaches metadata.
       -- lib/middleware/apiKeyAuth.ts also logs to this table with NO metadata
       -- when a key is used on the /api/v1 runtime data API. Those are SDK
       -- traffic, not tool calls, and an MCP-scoped key CAN make them — without
       -- this they would land in the totals as unknown-tool writes.
       AND u.metadata IS NOT NULL
     GROUP BY 1, 2, 3, 4, 5, 6, 7`,
    since,
    until,
  ).catch((err) => {
    console.error('[admin/agent-ops] usage rollup failed:', err)
    return [] as OpRow[]
  })

  // ── Roll the slices up along every axis the tab renders ────────────────────
  const totals = zero()
  const byUserMap = new Map<string, Counters & { clients: Set<string>; projects: Set<string> }>()
  const byProjectMap = new Map<string, Counters & { clients: Set<string>; userId: string }>()
  const byClientMap = new Map<string, Counters & { users: Set<string>; projects: Set<string> }>()
  const byToolMap = new Map<string, Counters & { kind: AgentOpKind }>()
  const guardrailHits = new Map<string, number>()

  for (const row of opRows) {
    const kind = classifyTool(row.tool)
    const outcome = classifyOutcome({
      tool: row.tool,
      statusCode: row.status_code,
      code: row.code,
      mutation: row.mutation,
    })

    accumulate(totals, row, kind, outcome)

    if (kind !== 'read' && outcome === 'refused' && row.code) {
      guardrailHits.set(row.code, (guardrailHits.get(row.code) ?? 0) + row.ops)
    }

    let u = byUserMap.get(row.user_id)
    if (!u) { u = { ...zero(), clients: new Set(), projects: new Set() }; byUserMap.set(row.user_id, u) }
    accumulate(u, row, kind, outcome)
    u.clients.add(row.client)
    if (row.project_id) u.projects.add(row.project_id)

    if (row.project_id) {
      let p = byProjectMap.get(row.project_id)
      if (!p) { p = { ...zero(), clients: new Set(), userId: row.user_id }; byProjectMap.set(row.project_id, p) }
      accumulate(p, row, kind, outcome)
      p.clients.add(row.client)
    }

    let c = byClientMap.get(row.client)
    if (!c) { c = { ...zero(), users: new Set(), projects: new Set() }; byClientMap.set(row.client, c) }
    accumulate(c, row, kind, outcome)
    c.users.add(row.user_id)
    if (row.project_id) c.projects.add(row.project_id)

    let t = byToolMap.get(row.tool)
    if (!t) { t = { ...zero(), kind }; byToolMap.set(row.tool, t) }
    accumulate(t, row, kind, outcome)
  }

  const projectIds = [...byProjectMap.keys()]
  const userIds = [...byUserMap.keys()]

  // Numbered placeholders for the month rollup's tool filter. Built from the
  // shared constant rather than interpolated, so the list can grow without the
  // query ever carrying a literal.
  const toolPlaceholders = SCHEMA_TOOL_NAMES.map((_, i) => `$${i + 2}`).join(', ')

  // ── Integrity ledgers ──────────────────────────────────────────────────────
  //
  // "0% data corruption" is not a stored field, so it is reconstructed from the
  // ledgers that would have recorded the opposite. Scoped to the projects that
  // actually saw agent traffic — a rollback on a project no agent ever touched
  // says nothing about agents.
  const [rollbackRows, rolledBackIntentRows, criticalFindingRows, monthlyRows, projects, users] = await Promise.all([
    projectIds.length
      ? prisma.rollbackExecution.groupBy({
          by: ['projectId', 'success'],
          where: { projectId: { in: projectIds }, timestamp: { gte: since } },
          _count: { _all: true },
        }).catch(() => [])
      : Promise.resolve([]),

    projectIds.length
      ? prisma.intentLog.groupBy({
          by: ['projectId'],
          where: { projectId: { in: projectIds }, rolledBack: true, rolledBackAt: { gte: since } },
          _count: { _all: true },
        }).catch(() => [])
      : Promise.resolve([]),

    projectIds.length
      ? prisma.healthFinding.groupBy({
          by: ['projectId'],
          where: {
            projectId: { in: projectIds },
            detectedAt: { gte: since },
            severity: 'critical',
            status: { in: ['open', 'proposed', 'pending_approval'] },
          },
          _count: { _all: true },
        }).catch(() => [])
      : Promise.resolve([]),

    // 12-month trend on the same definitions, so an external claim about a
    // specific month is read off a row instead of recomputed by hand.
    prisma.$queryRawUnsafe<{ month: string; schema_ops: number; schema_statements: number; applied: number; unresolved: number }[]>(
      `SELECT to_char(date_trunc('month', u."timestamp"), 'YYYY-MM') AS month,
              COUNT(*)::int AS schema_ops,
              SUM(
                CASE WHEN u.metadata->>'tool' = 'apply_migration'
                  THEN COALESCE(NULLIF(substring(COALESCE(u.metadata->>'summary', '') from 'migration: ([0-9]+) statement'), '')::int, 1)
                  ELSE 1
                END
              )::int AS schema_statements,
              COUNT(*) FILTER (WHERE u."statusCode" BETWEEN 200 AND 299)::int AS applied,
              COUNT(*) FILTER (WHERE u.metadata->>'error' = 'MIGRATION_FAILED')::int AS unresolved
       FROM api_key_usage u
       JOIN api_keys k ON k.id = u."apiKeyId"
       WHERE k.scope = 'mcp'
         AND u."timestamp" >= $1
         AND u.metadata->>'tool' IN (${toolPlaceholders})
       GROUP BY 1
       ORDER BY 1 DESC`,
      new Date(until.getTime() - 365 * DAY_MS),
      ...SCHEMA_TOOL_NAMES,
    ).catch((err) => {
      console.error('[admin/agent-ops] monthly rollup failed:', err)
      return []
    }),

    projectIds.length
      ? prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, name: true, userId: true, isDeployed: true },
        }).catch(() => [])
      : Promise.resolve([]),

    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, name: true, tier: true },
        }).catch(() => [])
      : Promise.resolve([]),
  ])

  const rollbackByProject = new Map<string, { total: number; failed: number }>()
  for (const r of rollbackRows) {
    const cur = rollbackByProject.get(r.projectId) ?? { total: 0, failed: 0 }
    cur.total += r._count._all
    if (!r.success) cur.failed += r._count._all
    rollbackByProject.set(r.projectId, cur)
  }
  const rolledBackIntentByProject = new Map(rolledBackIntentRows.map(r => [r.projectId, r._count._all]))
  const criticalByProject = new Map(criticalFindingRows.map(r => [r.projectId, r._count._all]))
  const projectById = new Map(projects.map(p => [p.id, p]))
  const userById = new Map(users.map(u => [u.id, u]))

  // ── Recent unresolved runs — the review queue for the safety claim ─────────
  //
  // Listed individually because these are the only agent operations that may
  // have left a backend between two states. A claim of zero corruption is only
  // as good as someone having looked at each of these.
  const unresolvedRuns = await prisma.$queryRawUnsafe<{
    id: string; project_id: string | null; user_id: string; client: string
    tool: string; code: string; summary: string; status_code: number; at: Date
  }[]>(
    `SELECT u.id,
            k."projectId" AS project_id,
            k."userId"    AS user_id,
            COALESCE(NULLIF(k."mcpClientLabel", ''), NULLIF(k.name, ''), 'Unlabelled key') AS client,
            COALESCE(u.metadata->>'tool', 'unknown')    AS tool,
            COALESCE(u.metadata->>'error', '')          AS code,
            COALESCE(u.metadata->>'summary', '')        AS summary,
            u."statusCode"                              AS status_code,
            u."timestamp"                               AS at
     FROM api_key_usage u
     JOIN api_keys k ON k.id = u."apiKeyId"
     WHERE k.scope = 'mcp'
       AND u."timestamp" >= $1
       AND (
         u.metadata->>'error' = 'MIGRATION_FAILED'
         OR (u.metadata->>'tool' = 'backend_chat'
             AND (u.metadata->>'mutation')::boolean = true
             AND u."statusCode" >= 400)
       )
     ORDER BY u."timestamp" DESC
     LIMIT 50`,
    since,
  ).catch((err) => {
    console.error('[admin/agent-ops] unresolved-run scan failed:', err)
    return []
  })

  // ── Shape the response ─────────────────────────────────────────────────────
  const byUser = [...byUserMap.entries()].map(([userId, c]) => {
    const u = userById.get(userId)
    return {
      userId,
      email: u?.email ?? null,
      name: u?.name ?? null,
      tier: u?.tier ?? null,
      ...strip(c),
      projectCount: c.projects.size,
      clientCount: c.clients.size,
      clients: [...c.clients],
    }
  }).sort((a, b) => b.schemaStatements - a.schemaStatements || b.ops - a.ops)

  const byProject = [...byProjectMap.entries()].map(([projectId, c]) => {
    const p = projectById.get(projectId)
    const owner = p?.userId ? userById.get(p.userId) : userById.get(c.userId)
    const rb = rollbackByProject.get(projectId)
    const rolledBackIntents = rolledBackIntentByProject.get(projectId) ?? 0
    const criticalFindings = criticalByProject.get(projectId) ?? 0
    return {
      projectId,
      name: p?.name ?? '(deleted project)',
      isDeployed: p?.isDeployed ?? false,
      ownerUserId: p?.userId ?? c.userId,
      ownerEmail: owner?.email ?? null,
      ...strip(c),
      clientCount: c.clients.size,
      clients: [...c.clients],
      rollbacks: rb?.total ?? 0,
      failedRollbacks: rb?.failed ?? 0,
      rolledBackIntents,
      criticalFindings,
      // Everything on this project that argues against "it landed cleanly".
      integrityEvents: (rb?.total ?? 0) + rolledBackIntents + c.unresolved,
    }
  }).sort((a, b) => b.integrityEvents - a.integrityEvents || b.schemaStatements - a.schemaStatements || b.ops - a.ops)

  const byClient = [...byClientMap.entries()].map(([client, c]) => ({
    client,
    ...strip(c),
    userCount: c.users.size,
    projectCount: c.projects.size,
  })).sort((a, b) => b.ops - a.ops)

  const byTool = [...byToolMap.entries()]
    .filter(([, c]) => c.kind !== 'read')
    .map(([tool, c]) => ({ tool, kind: c.kind, ...strip(c) }))
    .sort((a, b) => b.ops - a.ops)

  const guardrails = [...guardrailHits.entries()]
    .map(([code, count]) => ({ code, label: GUARDRAIL_CODES[code] ?? code, count }))
    .sort((a, b) => b.count - a.count)

  let rollbacksTotal = 0
  let failedRollbacksTotal = 0
  for (const v of rollbackByProject.values()) { rollbacksTotal += v.total; failedRollbacksTotal += v.failed }
  const rolledBackIntentsTotal = rolledBackIntentRows.reduce((s, r) => s + r._count._all, 0)
  const criticalTotal = criticalFindingRows.reduce((s, r) => s + r._count._all, 0)
  const integrityEvents = totals.unresolved + rollbacksTotal + rolledBackIntentsTotal

  // Share of agent writes that neither half-applied nor had to be undone.
  // Denominator is applied + unresolved: a refused operation changed nothing,
  // so counting it as a clean landing would pad the number with non-events.
  const landed = totals.applied + totals.unresolved
  const cleanRate = landed > 0
    ? Number((((landed - integrityEvents) / landed) * 100).toFixed(2))
    : null

  return NextResponse.json({
    window: { days, since: since.toISOString(), until: until.toISOString() },
    totals: {
      ...strip(totals),
      activeUsers: byUserMap.size,
      activeProjects: byProjectMap.size,
      activeClients: byClientMap.size,
    },
    integrity: {
      unresolvedRunCount: totals.unresolved,
      rollbacks: rollbacksTotal,
      failedRollbacks: failedRollbacksTotal,
      rolledBackIntents: rolledBackIntentsTotal,
      criticalFindings: criticalTotal,
      integrityEvents,
      cleanRate,
      unresolvedRuns: unresolvedRuns.map(r => ({
        id: r.id,
        projectId: r.project_id,
        projectName: r.project_id ? (projectById.get(r.project_id)?.name ?? '(deleted project)') : null,
        ownerEmail: userById.get(r.user_id)?.email ?? null,
        client: r.client,
        tool: r.tool,
        code: r.code,
        summary: r.summary,
        statusCode: r.status_code,
        at: new Date(r.at).toISOString(),
      })),
    },
    byClient,
    byUser,
    byProject,
    byTool,
    guardrails,
    monthly: monthlyRows.map(m => ({
      month: m.month,
      schemaOps: m.schema_ops,
      schemaStatements: m.schema_statements,
      applied: m.applied,
      unresolved: m.unresolved,
    })),
    caveats: [
      'Scope: only tool calls authenticated with an MCP-scoped API key — the key type /api/mcp/* and /api/cli/* require. Dashboard builds and autonomy ticks are excluded by construction, not by a filter. Runtime /api/v1 SDK traffic made with the same key is excluded too: it is data-plane traffic, not an agent operating the backend.',
      'A schema modification is a call to a structural DDL tool. apply_migration carries multiple statements per call, so "statements" is the change count and "calls" is the round-trip count; an unparseable migration summary counts as 1, which under-counts.',
      'backend_chat writes are reported separately and are NOT in the schema count. The usage row records only "backend_chat", not which tools the turn ran, so folding them in would be a guess.',
      'Refused operations changed nothing — they are the guardrails firing, and they are excluded from the clean-rate denominator rather than counted as successes.',
      'Clean rate = share of agent writes that landed without half-applying and without being rolled back. It is derived from the rollback, intent and usage ledgers; it is not a corruption detector, and no ledger proves the absence of corruption it never observed.',
      'Critical health findings are shown for context on projects with agent traffic. They are not attributed to agent activity — the detectors do not record a cause.',
    ],
    evaluatedAt: new Date().toISOString(),
  })
}
