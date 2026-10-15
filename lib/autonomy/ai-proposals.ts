/**
 * AI FIX PROPOSALS — bound, verifiable, human-approved
 * ====================================================
 * The investigator (lib/autonomy/investigator.ts) may suggest a repair. This
 * module decides whether that suggestion may be offered as "Approve & fix",
 * records it bound to exactly what it was proposed against, and runs it only
 * on a person's approval of that exact version.
 *
 * Offered only when all four hold (otherwise the suggestion stays advisory
 * text in the diagnosis):
 *   1. the action is a monomorphic typed action listed in PROPOSABLE, and its
 *      parameters pass that action's strict schema;
 *   2. the finding's type is probe-covered and its probe detects it right now;
 *   3. the action has a catalog postcondition (lib/autonomy/action-postconditions.ts);
 *   4. its rollback strategy is implemented (maintenance/rollback-capability.ts).
 *
 * A proposal's version hashes the project, finding, evidence, action,
 * parameters, the touched catalog, the rollback contract and the verifier
 * version. Approval must present it, everything is re-derived and compared,
 * and anything stale or changed gets "re-propose" instead of a mutation.
 * Approval claims the proposal with one conditional update, so a second click
 * or a concurrent request gets the first one's outcome, never a second change.
 *
 * Agents can read proposals; only a person in the dashboard can approve one
 * (app/api/projects/[id]/health/proposals/[proposalId]/approve). Nothing here
 * runs a proposal on its own: lib/autonomy/ai-promotion.ts ships empty.
 */

import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { normalizeFindingType } from '@/lib/core/types'
import { executeApprovedProposal, type ProposalExecution } from '@/lib/core/auto-fix-engine'
import { canRollback, rollbackContract, type RollbackStrategy } from './maintenance/rollback-capability'
import { hasPostcondition, POSTCONDITION_REGISTRY_VERSION } from './action-postconditions'
import { evidenceFingerprint } from './finding-fingerprint'
import { typeFamily } from './intent-conformance'

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/
const COLUMN_TYPES = ['text', 'integer', 'bigint', 'numeric', 'boolean', 'uuid', 'timestamptz', 'timestamp', 'date', 'jsonb'] as const

interface FindingView {
  type: string
  base: string
  details: Record<string, unknown>
}

interface ProposableAction {
  params: z.ZodType<Record<string, unknown>>
  /** The same parameters as JSON Schema, for the investigator's answer (lib/autonomy/investigator.ts). */
  paramsSchema: Record<string, unknown>
  /** One line telling the investigator when to use it. */
  use: string
  /** Whether this action can repair this kind of finding at all, before any parameters. */
  applies(finding: FindingView): boolean
  rollback: RollbackStrategy
  schemaTouching: boolean
  /** Null when this action repairs this finding; otherwise why not. */
  repairs(finding: FindingView, params: Record<string, unknown>): string | null
  /** Null when the live catalog is in the state the action assumes; otherwise why not. */
  precondition(projectId: string, params: Record<string, unknown>): Promise<string | null>
  /** The catalog the action reads and writes, as one hash. */
  catalogFingerprint(projectId: string, params: Record<string, unknown>): Promise<string>
}

/** Read in the project's region; a region error propagates to the caller. */
async function tableColumns(projectId: string, table: string) {
  const db = await workspaceRawClient(projectId)
  const schema = await resolveWorkspaceSchema(projectId)
  return db.$queryRawUnsafe<Array<{ column_name: string; data_type: string; is_nullable: string }>>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
    schema,
    table,
  )
}

/** The actions a proposal may use. Typed and monomorphic: no FIX_* handlers that pick their own repair. */
const PROPOSABLE: Record<string, ProposableAction> = {
  ADD_COLUMN: {
    params: z
      .object({ tableName: z.string().regex(IDENT), columnName: z.string().regex(IDENT), columnType: z.enum(COLUMN_TYPES) })
      .strict(),
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tableName', 'columnName', 'columnType'],
      properties: {
        tableName: { type: 'string' },
        columnName: { type: 'string' },
        columnType: { type: 'string', enum: [...COLUMN_TYPES] },
      },
    },
    use: 'Add the one column a missing-column finding names to its table, in the type family that was requested.',
    applies: (finding) => finding.base === 'intent_drift' && finding.details.driftKind === 'missing_column',
    rollback: 'drop_column',
    schemaTouching: true,
    repairs(finding, p) {
      const d = finding.details
      if (finding.base !== 'intent_drift' || d.driftKind !== 'missing_column') return 'it is not a missing-column finding'
      if (d.tableName !== p.tableName || d.columnName !== p.columnName) return 'it adds a different column than the one this finding says is missing'
      if (typeFamily(String(d.requested ?? '')) !== typeFamily(String(p.columnType))) return 'it adds the column in a different type than was requested'
      return null
    },
    async precondition(projectId, p) {
      const cols = await tableColumns(projectId, String(p.tableName))
      if (cols.length === 0) return `table "${p.tableName}" does not exist`
      if (cols.some((c) => c.column_name === p.columnName)) return `column "${p.columnName}" already exists`
      return null
    },
    async catalogFingerprint(projectId, p) {
      const cols = await tableColumns(projectId, String(p.tableName))
      const shape = cols.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`).join(',')
      return crypto.createHash('sha256').update(`${p.tableName}|${shape}`).digest('hex').slice(0, 32)
    },
  },
}

/** A typed repair the investigator may propose, as the model is told about it. */
export interface ProposalSpec {
  action: string
  use: string
  params: Record<string, unknown>
}

/**
 * The typed repairs an investigation of this finding may propose, empty when
 * none applies. The investigator is held to these: without them it was told
 * only "an action name and its parameters", and Claude proposed the detector's
 * own raw SQL through apply_migration, which no proposal may run (staging,
 * 2026-10-12). Everything here is still re-checked when the proposal is made.
 */
export function proposableFor(finding: { type: string; details: Record<string, unknown> }): ProposalSpec[] {
  const base = normalizeFindingType(finding.type, finding.details)?.base ?? finding.type
  const view: FindingView = { type: finding.type, base, details: finding.details }
  return Object.entries(PROPOSABLE)
    .filter(([, spec]) => spec.applies(view))
    .map(([action, spec]) => ({ action, use: spec.use, params: spec.paramsSchema }))
}

/** One plain line for what a proposal would do. */
export function describeProposal(action: string, params: Record<string, unknown>): string {
  switch (action) {
    case 'ADD_COLUMN':
      return `Add the column "${params.columnName}" (${params.columnType}) to "${params.tableName}", as it was requested. Existing rows get no value in it.`
    default:
      return `Run ${action}.`
  }
}

export function repairClassOf(findingBase: string, action: string): string {
  return `${findingBase}:${action}`
}

function versionOf(input: {
  projectId: string
  findingId: string
  evidence: string
  action: string
  params: Record<string, unknown>
  catalog: string
  rollback: RollbackStrategy
}): string {
  const canonicalParams = JSON.stringify(input.params, Object.keys(input.params).sort())
  return crypto
    .createHash('sha256')
    .update(
      [input.projectId, input.findingId, input.evidence, input.action, canonicalParams, input.catalog,
        rollbackContract(input.rollback), POSTCONDITION_REGISTRY_VERSION].join('\n'),
    )
    .digest('hex')
}

type Eligibility =
  | { ok: true; spec: ProposableAction; params: Record<string, unknown>; finding: FindingView; evidence: string; catalog: string }
  | { ok: false; reason: string }

/** All four conditions, plus the action's own fit and live precondition, checked now. */
async function eligibility(projectId: string, findingId: string, action: string, rawParams: unknown): Promise<Eligibility> {
  const spec = PROPOSABLE[action]
  if (!spec) return { ok: false, reason: `${action} is not an action an AI proposal may use` }
  const parsed = spec.params.safeParse(rawParams)
  if (!parsed.success) return { ok: false, reason: `its parameters are invalid: ${parsed.error.issues[0]?.message ?? 'bad shape'}` }
  const params = parsed.data
  if (!hasPostcondition(action)) return { ok: false, reason: `${action} has no postcondition that could verify it` }
  if (!canRollback(spec.rollback)) return { ok: false, reason: `${action} cannot be undone on this deployment` }

  const row = await prisma.healthFinding.findFirst({ where: { id: findingId, projectId } })
  if (!row) return { ok: false, reason: 'the finding no longer exists' }
  if (row.status !== 'open' && row.status !== 'pending_approval') return { ok: false, reason: `the finding is ${row.status}` }
  const details = (row.details ?? {}) as Record<string, unknown>
  const base = normalizeFindingType(row.type, details)?.base ?? row.type
  const finding: FindingView = { type: row.type, base, details }

  const misfit = spec.repairs(finding, params)
  if (misfit) return { ok: false, reason: misfit }

  const { probeCoveredTypes, recheckGap } = await import('./desired-state')
  if (!probeCoveredTypes().has(base)) return { ok: false, reason: `no probe can re-check a ${base} finding` }
  const detected = await recheckGap(projectId, row.type, details).catch(() => 'error' as const)
  if (detected !== 'unresolved') {
    return { ok: false, reason: detected === 'resolved' ? 'the issue is no longer detected' : 'the check for this issue could not run' }
  }

  const blocked = await spec.precondition(projectId, params)
  if (blocked) return { ok: false, reason: blocked }

  return {
    ok: true,
    spec,
    params,
    finding,
    evidence: evidenceFingerprint(row.type, details),
    catalog: await spec.catalogFingerprint(projectId, params),
  }
}

export type ProposeResult = { ok: true; proposalId: string; proposalVersion: string } | { ok: false; reason: string }

/** Record a suggested repair as an approvable proposal, or say why it may not be one. */
export async function proposeRepair(input: {
  projectId: string
  findingId: string
  action: string
  paramsJson: string
  model: string
  rationale: string
}): Promise<ProposeResult> {
  let raw: unknown
  try {
    raw = JSON.parse(input.paramsJson)
  } catch {
    return { ok: false, reason: 'its parameters are not valid JSON' }
  }
  const e = await eligibility(input.projectId, input.findingId, input.action, raw)
  if ('reason' in e) return { ok: false, reason: e.reason }

  const proposalVersion = versionOf({
    projectId: input.projectId,
    findingId: input.findingId,
    evidence: e.evidence,
    action: input.action,
    params: e.params,
    catalog: e.catalog,
    rollback: e.spec.rollback,
  })
  // One live proposal per finding: an older one is superseded.
  await prisma.aiFixProposal.updateMany({
    where: { projectId: input.projectId, findingId: input.findingId, status: 'pending' },
    data: { status: 'stale' },
  })
  const row = await prisma.aiFixProposal.create({
    data: {
      projectId: input.projectId,
      findingId: input.findingId,
      action: input.action,
      params: e.params as any,
      proposalVersion,
      evidenceFingerprint: e.evidence,
      catalogFingerprint: e.catalog,
      model: input.model,
      rationale: input.rationale.slice(0, 2000),
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    },
    select: { id: true },
  })
  // The person decides in the Review Queue, which lists pending_approval
  // findings only: an open finding with a proposal moves there.
  const queued = await prisma.healthFinding.updateMany({
    where: { id: input.findingId, projectId: input.projectId, status: 'open' },
    data: { status: 'pending_approval' },
  })
  if (queued.count > 0) {
    await audit(input.projectId, 'HEALTH_FIX_AWAITING_APPROVAL', {
      findingId: input.findingId,
      via: 'ai_proposal',
      proposalId: row.id,
      reason: describeProposal(input.action, e.params),
    })
  }
  return { ok: true, proposalId: row.id, proposalVersion }
}

export interface ApprovalAnswer {
  status: 200 | 404 | 409
  body: {
    ok: boolean
    code?: 'NOT_FOUND' | 'STALE' | 'EXPIRED' | 'ALREADY_DECIDED' | 'IN_PROGRESS' | 'VERSION_MISMATCH' | 'RETRY'
    message: string
    outcome?: ProposalExecution['outcome']
    fixed?: boolean
    checks?: Pick<ProposalExecution, 'postcondition' | 'recheck' | 'regressionCheck' | 'regressions'>
  }
}

async function audit(projectId: string, action: string, details: Record<string, unknown>) {
  await prisma.auditLog
    .create({ data: { projectId, action, type: 'health', details: JSON.stringify(details), timestamp: new Date() } })
    .catch(() => {})
}

/** A person approves one exact proposal version. */
export async function approveProposal(input: {
  projectId: string
  proposalId: string
  proposalVersion: string
  userId: string
}): Promise<ApprovalAnswer> {
  const proposal = await prisma.aiFixProposal.findFirst({ where: { id: input.proposalId, projectId: input.projectId } })
  if (!proposal) return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: 'That proposal was not found.' } }

  if (proposal.status !== 'pending') {
    const outcome = proposal.outcome as { message?: string; outcome?: ProposalExecution['outcome']; fixed?: boolean } | null
    if (proposal.status === 'executing') {
      return { status: 409, body: { ok: false, code: 'IN_PROGRESS', message: 'This proposal is already being run.' } }
    }
    if (proposal.status === 'executed' || proposal.status === 'failed') {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'ALREADY_DECIDED',
          message: `This proposal was already approved. ${outcome?.message ?? ''}`.trim(),
          outcome: outcome?.outcome,
          fixed: outcome?.fixed,
        },
      }
    }
    return { status: 409, body: { ok: false, code: 'STALE', message: 'This proposal is no longer current. Ask for a fresh one.' } }
  }
  if (proposal.expiresAt.getTime() <= Date.now()) {
    await prisma.aiFixProposal.updateMany({ where: { id: proposal.id, status: 'pending' }, data: { status: 'expired' } })
    return { status: 409, body: { ok: false, code: 'EXPIRED', message: 'This proposal expired. Ask for a fresh one.' } }
  }
  if (input.proposalVersion !== proposal.proposalVersion) {
    return { status: 409, body: { ok: false, code: 'VERSION_MISMATCH', message: 'What you approved is not the current proposal. Reload and review it again.' } }
  }

  // Re-derive everything the version binds, against the live state.
  const e = await eligibility(input.projectId, proposal.findingId, proposal.action, proposal.params)
  const refusal = 'reason' in e ? e.reason : null
  const current =
    !('reason' in e) &&
    versionOf({
      projectId: input.projectId,
      findingId: proposal.findingId,
      evidence: e.evidence,
      action: proposal.action,
      params: e.params,
      catalog: e.catalog,
      rollback: e.spec.rollback,
    }) === proposal.proposalVersion
  if ('reason' in e || !current) {
    await prisma.aiFixProposal.updateMany({ where: { id: proposal.id, status: 'pending' }, data: { status: 'stale' } })
    await audit(input.projectId, 'AI_PROPOSAL_STALE', { proposalId: proposal.id, reason: refusal ?? 'the catalog or evidence changed' })
    return {
      status: 409,
      body: {
        ok: false,
        code: 'STALE',
        message: `Nothing was changed: ${refusal ?? 'the table or the finding changed after this was proposed'}. Ask for a fresh proposal.`,
      },
    }
  }

  // The claim. Only one request moves it out of pending.
  const executionId = crypto.randomUUID()
  const claimed = await prisma.aiFixProposal.updateMany({
    where: { id: proposal.id, status: 'pending', proposalVersion: proposal.proposalVersion },
    data: { status: 'executing', executionId, decidedBy: input.userId, decidedAt: new Date() },
  })
  if (claimed.count === 0) return approveProposal(input)

  await audit(input.projectId, 'AI_PROPOSAL_APPROVED', {
    proposalId: proposal.id,
    findingId: proposal.findingId,
    action: proposal.action,
    params: proposal.params,
    approvedBy: input.userId,
  })

  const run = await executeApprovedProposal({
    projectId: input.projectId,
    findingId: proposal.findingId,
    action: proposal.action,
    params: e.params,
    schemaTouching: e.spec.schemaTouching,
    expectedCatalogFingerprint: proposal.catalogFingerprint,
    currentCatalogFingerprint: () => e.spec.catalogFingerprint(input.projectId, e.params),
  })

  if (!run.mutated && run.retryable) {
    await prisma.aiFixProposal.update({
      where: { id: proposal.id },
      data: { status: 'pending', executionId: null, decidedBy: null, decidedAt: null },
    })
    return { status: 409, body: { ok: false, code: 'RETRY', message: run.message } }
  }

  const outcome = {
    outcome: run.outcome,
    fixed: run.fixed,
    mutated: run.mutated,
    message: run.message,
    postcondition: run.postcondition,
    recheck: run.recheck,
    regressionCheck: run.regressionCheck,
    regressions: run.regressions,
  }
  await prisma.aiFixProposal.update({
    where: { id: proposal.id },
    data: { status: !run.mutated ? 'stale' : run.fixed ? 'executed' : 'failed', outcome: outcome as any },
  })

  if (run.mutated && run.rollbackData) {
    const fresh = await prisma.healthFinding.findUnique({ where: { id: proposal.findingId } })
    const details = (fresh?.details ?? {}) as Record<string, unknown>
    await prisma.healthFinding.update({
      where: { id: proposal.findingId },
      data: run.fixed
        ? {
            status: 'auto_fixed',
            autoFixed: true,
            fixAppliedAt: new Date(),
            details: { ...details, rollbackData: run.rollbackData } as any,
          }
        : {
            // Ran but not verified: kept for the record and for Undo, and it
            // stops the same change being run again on no evidence.
            details: {
              ...details,
              appliedUnverified: {
                fixAction: (run.rollbackData as Record<string, unknown>).fixAction,
                statements: (run.rollbackData as Record<string, unknown>).statements,
                snapshotId: (run.rollbackData as Record<string, unknown>).snapshotId,
                at: new Date().toISOString(),
                source: 'ai_proposal',
                reason: run.message,
              },
            } as any,
          },
    })
    if (run.fixed) {
      await audit(input.projectId, 'HEALTH_FIX_APPROVED', {
        findingId: proposal.findingId,
        source: 'ai_proposal',
        proposalId: proposal.id,
        approvedBy: input.userId,
        verification: 'confirmed',
      })
    }
  }
  await audit(input.projectId, 'AI_PROPOSAL_EXECUTED', { proposalId: proposal.id, findingId: proposal.findingId, executionId, ...outcome })

  return {
    status: 200,
    body: {
      ok: run.fixed,
      message: run.message,
      outcome: run.outcome,
      fixed: run.fixed,
      checks: { postcondition: run.postcondition, recheck: run.recheck, regressionCheck: run.regressionCheck, regressions: run.regressions },
    },
  }
}

/** The live proposal for a finding, for display. Agents may read it; they cannot approve it. */
export async function liveProposalFor(projectId: string, findingId: string) {
  return prisma.aiFixProposal.findFirst({
    where: { projectId, findingId, status: 'pending', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, action: true, params: true, proposalVersion: true, rationale: true, model: true, expiresAt: true },
  })
}
