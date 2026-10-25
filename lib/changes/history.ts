/**
 * The change history as the console, the routes and the agent tools read it.
 *
 * One entry per governed change, with its lifecycle folded in: applied and
 * verified, recovered automatically, restored by a person, waiting for an
 * approval. A recovery is a record of its own in the ledger (so the state it
 * replaced is protected), but it is not a separate entry here: it is how the
 * change it recovered ended. The full sequence, every event and every check,
 * is in the change's details.
 */

import { prisma } from '@/lib/db/prisma'
import type { CatalogSnapshot, TableState } from './catalog'
import { describeChange } from './describe'
import { checkpointIntact } from './integrity'
import type { StoredSnapshot } from './ledger'
import { rollbackWindowDays } from './policy'
import { availabilityOf, type Availability } from './recovery'
import { restoreRequestChangeId, type ChangePreservation, type ChangeStep, type TableChange } from './types'
import { describeOp, opsOf, type ResourceOp, type ResourceSnapshot } from './resources'
import type { ChangeVerification } from './verify'
import { quotesKeptHere } from './residency'

export interface ChangeActor {
  /** agent: a coding agent's key. person: someone in the console or approving. system: Backenly itself. */
  type: 'agent' | 'person' | 'system'
  label: string
  userId: string | null
  apiKeyId: string | null
}

/** How the change's lifecycle ended, in the console's terms. */
export type ChangeOutcomeState =
  | 'healthy'
  | 'unverified'
  | 'recovered'
  | 'restored'
  | 'awaiting_approval'
  | 'kept'
  | 'needs_attention'
  | 'in_progress'
  | 'failed'

export interface ChangeSummary {
  id: string
  seq: number
  /** One plain sentence: what it did. */
  summary: string
  /** What was asked for, as the caller put it. */
  title: string
  source: string
  risk: string | null
  status: string
  createdAt: string
  actor: ChangeActor
  /** Tables, objects and the rest of the backend it touched. */
  touched: string[]
  /** The parts of the backend it touched: database, auth, storage, functions, webhooks, env, keys, integrations. */
  resources: string[]
  outcome: {
    state: ChangeOutcomeState
    /** Why, when it is not simply applied and verified. Plain language. */
    note: string | null
    /** When it was recovered or restored, and by whom. */
    at: string | null
    by: ChangeActor | null
  }
  /** What the ⋯ menu may offer. `recordId` is what the restore or reapply acts on. */
  action: (Availability & { kind: 'restore' | 'reapply'; recordId: string }) | null
  approvalId: string | null
}

export interface ChangeEvent {
  type: string
  at: string
  data: Record<string, unknown> | null
}

export interface ChangeDetail extends ChangeSummary {
  error: string | null
  steps: ChangeStep[]
  statements: Array<{ sql: string; params?: string[] }>
  footprint: TableChange[]
  /** What it did to the rest of the backend, one sentence per item ("Changed function sendWelcome: power"). */
  resourceChanges: string[]
  /** Each touched table before and after. */
  before: Record<string, TableState>
  after: Record<string, TableState>
  verification: ChangeVerification | null
  preserved: ChangePreservation | null
  events: ChangeEvent[]
  checkpoint: { hash: string | null; intact: boolean; resources: string[]; parentSeq: number | null }
  /**
   * False for a project kept outside the home region: its SQL, step summaries
   * and error text stay there and are not on this record (lib/changes/residency.ts).
   */
  quoted: boolean
  /** The recovery records that acted on this change, oldest first. */
  recoveries: Array<{
    id: string
    seq: number
    status: string
    summary: string
    createdAt: string
    actor: ChangeActor
    verification: ChangeVerification | null
    statements: Array<{ sql: string }>
    preserved: ChangePreservation | null
  }>
}

type Row = Awaited<ReturnType<typeof prisma.backendChange.findFirstOrThrow>>

async function actorsFor(rows: Row[]): Promise<Map<string, ChangeActor>> {
  const userIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))]
  const keyIds = [...new Set(rows.map((r) => r.apiKeyId).filter((x): x is string => !!x))]
  const [users, keys] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    keyIds.length ? prisma.apiKey.findMany({ where: { id: { in: keyIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])
  const userBy = new Map<string, string>(users.map((u): [string, string] => [u.id, u.name || u.email]))
  const keyBy = new Map<string, string>(keys.map((k): [string, string] => [k.id, k.name]))
  const out = new Map<string, ChangeActor>()
  for (const r of rows) {
    const person = r.actorUserId ? userBy.get(r.actorUserId) ?? 'a former member' : null
    let actor: ChangeActor
    if (r.source === 'system') {
      actor = { type: 'system', label: 'Backenly', userId: null, apiKeyId: null }
    } else if (r.apiKeyId && (r.source === 'approval' || r.source === 'branch_merge')) {
      actor = { type: 'person', label: `${person ?? 'Someone'}, approving ${keyBy.get(r.apiKeyId) ?? 'an agent'}'s request`, userId: r.actorUserId, apiKeyId: r.apiKeyId }
    } else if (r.apiKeyId) {
      actor = { type: 'agent', label: keyBy.get(r.apiKeyId) ?? 'A coding agent (key since revoked)', userId: r.actorUserId, apiKeyId: r.apiKeyId }
    } else if (r.source === 'autonomy') {
      actor = { type: 'system', label: 'Backenly autonomy', userId: null, apiKeyId: null }
    } else if (person) {
      actor = { type: 'person', label: person, userId: r.actorUserId, apiKeyId: null }
    } else {
      actor = { type: 'system', label: 'Backenly', userId: null, apiKeyId: null }
    }
    out.set(r.id, actor)
  }
  return out
}

function footprintOf(r: Row): TableChange[] {
  return (r.footprint as unknown as TableChange[] | null) ?? []
}

/** What it did to the rest of the backend (lib/changes/resources). */
function resourceOpsOf(r: Row): ResourceOp[] {
  return opsOf((r.checkpoint as { resources?: ResourceSnapshot } | null)?.resources, (r.resultState as { resources?: ResourceSnapshot } | null)?.resources)
}

function failingNote(r: Row): string | null {
  const v = r.verification as unknown as ChangeVerification | null
  const failing = v?.checks.find((c) => c.outcome === 'contradicted')
  // The finding, not the check's name: "Row-level security kept: row-level
  // security turned off on invoices" contradicts itself on one line.
  if (failing) return failing.detail.charAt(0).toUpperCase() + failing.detail.slice(1)
  if (r.status === 'partially_applied' || r.error) return r.error ? r.error.split('\n')[0].slice(0, 300) : null
  return null
}

function outcomeOf(r: Row, recovery: Row | null, recoveryActor: ChangeActor | null): ChangeSummary['outcome'] {
  const at = r.recoveredAt?.toISOString() ?? null
  switch (r.status) {
    case 'healthy':
      return { state: 'healthy', note: null, at: null, by: null }
    case 'unverified': {
      const v = r.verification as unknown as ChangeVerification | null
      const why = v?.checks.find((c) => c.outcome === 'inconclusive')
      return { state: 'unverified', note: why ? `Could not check: ${why.label.toLowerCase()}.` : null, at: null, by: null }
    }
    case 'recovered':
      return { state: 'recovered', note: failingNote(r), at, by: recoveryActor }
    case 'restored':
      return { state: 'restored', note: null, at, by: recoveryActor }
    case 'awaiting_approval':
      return { state: 'awaiting_approval', note: failingNote(r), at: null, by: null }
    case 'kept':
      return { state: 'kept', note: failingNote(r), at: null, by: null }
    case 'verification_failed':
    case 'partially_applied':
    case 'recovery_failed':
    case 'manual_intervention_required':
      return { state: 'needs_attention', note: r.error && r.status === 'manual_intervention_required' ? r.error : failingNote(r), at: null, by: null }
    case 'failed':
      return { state: 'failed', note: r.error?.split('\n')[0].slice(0, 300) ?? null, at: null, by: null }
    default:
      return { state: 'in_progress', note: null, at: null, by: null }
  }
}

/** For a recovery record, `target` is the change it restored. */
function availabilityFor(r: Row, windowDays: number, target: Row | null): Availability {
  return availabilityOf(
    {
      kind: r.kind,
      status: r.status,
      footprint: footprintOf(r),
      createdAt: r.createdAt,
      intact: checkpointIntact(r),
      sealed: !!r.checkpointHash,
      resourceOps: resourceOpsOf(r),
      groupId: r.groupId,
    },
    windowDays,
    {
      targetStatus: target?.status ?? null,
      targetVerified: (target?.verification as unknown as ChangeVerification | null)?.outcome === 'confirmed',
    },
  )
}

async function summarize(projectId: string, rows: Row[], windowDays: number): Promise<ChangeSummary[]> {
  // The latest recovery of each change, for how it ended and for "Reapply".
  const recoveryIds = rows.map((r) => r.recoveredById).filter((x): x is string => !!x)
  const recoveries = recoveryIds.length
    ? await prisma.backendChange.findMany({ where: { projectId, id: { in: recoveryIds } } })
    : []
  const recoveryBy = new Map(recoveries.map((r) => [r.id, r]))
  const actors = await actorsFor([...rows, ...recoveries])
  const approvals = await prisma.agentApprovalRequest.findMany({
    where: { projectId, status: 'pending', tool: 'revert_schema_change' },
    select: { id: true, toolArgs: true },
  })
  const approvalFor = new Map<string, string>()
  for (const a of approvals) {
    const id = restoreRequestChangeId(a.toolArgs)
    if (id) approvalFor.set(id, a.id)
  }

  return rows.map((r) => {
    const recovery = r.recoveredById ? recoveryBy.get(r.recoveredById) ?? null : null
    const footprint = footprintOf(r)
    const outcome = outcomeOf(r, recovery, recovery ? actors.get(recovery.id) ?? null : null)
    let action: ChangeSummary['action'] = null
    if (r.status === 'restored' && recovery) {
      action = { ...availabilityFor(recovery, windowDays, r), kind: 'reapply', recordId: recovery.id }
    } else if (r.status !== 'recovered' && r.status !== 'failed') {
      action = { ...availabilityFor(r, windowDays, null), kind: 'restore', recordId: r.id }
    }
    return {
      id: r.id,
      seq: r.seq,
      summary: r.summary ?? describeChange(footprint),
      title: r.title,
      source: r.source,
      risk: r.risk,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      actor: actors.get(r.id)!,
      touched: [...footprint.map((c) => c.after ?? c.before ?? ''), ...resourceOpsOf(r).map((o) => (o.after ?? o.before)!.label)].filter(Boolean),
      resources: r.resources,
      outcome,
      action,
      approvalId: approvalFor.get(r.id) ?? null,
    }
  })
}

/**
 * Governed changes, newest first. Recovery records are folded into the change
 * they recovered, and attempts that changed nothing are left out: nobody needs
 * to act on them, and the record of each is still there for an audit.
 */
export async function listChanges(
  projectId: string,
  /** `resource`: only the changes that touched it ('database', or a lib/changes/resources id). */
  opts: { limit?: number; beforeSeq?: number; resource?: string } = {},
): Promise<{ changes: ChangeSummary[]; windowDays: number; nextBeforeSeq: number | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)
  const rows = await prisma.backendChange.findMany({
    // Snapshot restores are in the history too: the biggest change of all.
    where: {
      projectId,
      kind: { in: ['change', 'snapshot_restore'] },
      status: { not: 'failed' },
      ...(opts.beforeSeq ? { seq: { lt: opts.beforeSeq } } : {}),
      ...(opts.resource ? { resources: { has: opts.resource } } : {}),
    },
    orderBy: { seq: 'desc' },
    take: limit + 1,
  })
  const page = rows.slice(0, limit)
  const windowDays = await rollbackWindowDays(projectId)
  return {
    changes: await summarize(projectId, page, windowDays),
    windowDays,
    nextBeforeSeq: rows.length > limit ? page[page.length - 1].seq : null,
  }
}

export async function getChange(projectId: string, changeId: string): Promise<ChangeDetail | null> {
  const r = await prisma.backendChange.findFirst({ where: { id: changeId, projectId } })
  if (!r) return null
  const windowDays = await rollbackWindowDays(projectId)
  const [summary] = await summarize(projectId, [r], windowDays)
  const recoveries = await prisma.backendChange.findMany({ where: { projectId, kind: 'recovery', recoversId: r.id }, orderBy: { seq: 'asc' } })
  const actors = await actorsFor(recoveries)
  const events = await prisma.backendChangeEvent.findMany({
    where: { changeId: { in: [r.id, ...recoveries.map((x) => x.id)] } },
    orderBy: { at: 'asc' },
  })
  const parent = r.parentId ? await prisma.backendChange.findUnique({ where: { id: r.parentId }, select: { seq: true } }) : null
  const checkpoint = ((r.checkpoint as any)?.database ?? null) as StoredSnapshot | null
  const resultState = r.resultState as unknown as CatalogSnapshot | null
  return {
    ...summary,
    error: r.error,
    steps: (r.steps as unknown as ChangeStep[] | null) ?? [],
    statements: ((r.statements as unknown as Array<{ sql: string; params?: string[] }> | null) ?? []).map((s) => ({
      sql: s.sql,
      ...(s.params ? { params: s.params } : {}),
    })),
    footprint: footprintOf(r),
    resourceChanges: resourceOpsOf(r).map(describeOp),
    before: checkpoint?.tables ?? {},
    after: resultState?.tables ?? {},
    verification: (r.verification as unknown as ChangeVerification | null) ?? null,
    preserved: (r.preserved as unknown as ChangePreservation | null) ?? null,
    events: events.map((e) => ({ type: e.type, at: e.at.toISOString(), data: (e.data as Record<string, unknown> | null) ?? null })),
    checkpoint: { hash: r.checkpointHash, intact: checkpointIntact(r), resources: r.resources, parentSeq: parent?.seq ?? null },
    quoted: await quotesKeptHere(projectId),
    recoveries: recoveries.map((x) => ({
      id: x.id,
      seq: x.seq,
      status: x.status,
      summary: x.summary ?? x.title,
      createdAt: x.createdAt.toISOString(),
      actor: actors.get(x.id)!,
      verification: (x.verification as unknown as ChangeVerification | null) ?? null,
      statements: ((x.statements as unknown as Array<{ sql: string }> | null) ?? []).map((s) => ({ sql: s.sql })),
      preserved: (x.preserved as unknown as ChangePreservation | null) ?? null,
    })),
  }
}
