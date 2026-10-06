/**
 * STRUCTURAL EVOLUTION — the backend's shape, kept right as the product grows
 * ===========================================================================
 *
 * Self-healing keeps a backend working. This keeps it WELL-SHAPED, which is a
 * different promise and needs a different engine: nothing is broken when
 * `orders` has slowly become orders-plus-refunds-plus-coupons, so nothing the
 * healing loop watches will ever say so. An engineer would, in a design review,
 * and would then do the extraction carefully over a week. This does both.
 *
 *   sense     ./facts.ts, ./sensing.ts    catalog, sampled rows, schema history,
 *                                         repairs, traffic, consumers
 *   decide    ./concerns.ts               which columns are a separate concern,
 *                                         and whether keeping them costs anything
 *   plan      ./plan.ts, ./sql.ts         a behaviour-preserving ladder whose
 *                                         consent binds to its exact SQL
 *   rehearse  ./rehearse.ts               the ladder, run for real on a copy,
 *                                         always rolled back
 *   execute   ./execute.ts                governed, resumable, flag-gated
 *   prove     ./reconcile.ts              the only witness to "they agree"
 *   undo      ./rollback.ts               lossless or refused
 *
 * ── What it will never do ───────────────────────────────────────────────────
 *
 * Call a model. Detection and repair are deterministic on this platform, and
 * so is restructuring: the vocabulary is closed and every statement is rendered
 * from the catalog (see __tests__/autonomy/autonomy-is-model-free.test.ts for
 * the rule this inherits).
 *
 * Drop a column. `contract` is planned, shown with its exact SQL and every
 * consumer a person must migrate first, and never run.
 *
 * Restructure without consent. Every ladder needs a person to approve its exact
 * version; the scheduler only RESUMES what was approved.
 *
 * Read-only. Running an approved change, observing it and remembering it are
 * the Architecture Evolution Engine's (lib/evolution-engine/engine.ts), which
 * drives this primitive through ./primitive.ts.
 */

import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import type { PriorOutcome } from '@/lib/evolution-engine/levels'
import { listBaseTables, readTableFacts, relationExists } from './facts'
import {
  analyzeTable,
  partitionColumns,
  WINDOW_DAYS,
  type ConcernAssessment,
  type TableAssessment,
} from './concerns'
import {
  columnHistory,
  consumersOf,
  readProjectConsumers,
  readRepairs,
  readRequestsByTable,
  readSnapshots,
  samplePresence,
} from './sensing'
import { buildExtractionPlan, extractionPlanId, requiredTier, type ExtractionPlan } from './plan'
import { isOurSatellite } from './primitives'
import { latestRun, readLatestEvolutionApproval, type LedgerRun } from './consent'
import type { ExtractionSpec } from './sql'
import { ladderNames } from './sql'

export { resolveExtractionPlan, normaliseSpec, isResolveRefusal } from './resolve'
export { executeExtraction } from './execute'
export { rollbackExtraction } from './rollback'
export { rehearseExtraction } from './rehearse'
export { grantEvolutionApproval, revokeEvolutionApproval, isGrantRefusal, isRevokeRefusal } from './consent'

/** Tables analysed per project per read. A wider schema is analysed on its first N. */
export const MAX_TABLES = 60

export type ProposalState =
  | 'proposed'
  | 'approved'
  | 'in_progress'
  | 'halted'
  | 'extracted'
  | 'rolled_back'

export interface ProposalView extends ConcernAssessment {
  planId: string
  state: ProposalState
  spec: ExtractionSpec
  plan: Pick<
    ExtractionPlan,
    'planVersion' | 'validity' | 'blockedReasons' | 'contractBlockers' | 'caveats' | 'access' | 'steps'
  > & { requiredTier: number }
  consent: {
    approvalId: string
    planVersion: string
    approvedBy: string
    createdAt: string
    revoked: boolean
    /** False when consent is for an older version of this plan. */
    current: boolean
  } | null
  lastRun: (Omit<LedgerRun, 'startedAt' | 'completedAt' | 'createdAt'> & { at: string }) | null
  /** How a client moves from the old columns to the new table. */
  clientMigration: Array<{ purpose: string; before: string; after: string }>
}

export interface EvolutionReport {
  projectId: string
  analyzedAt: string
  windowDays: number
  /** Executable proposals, and concerns that already have consent or a run. */
  proposals: ProposalView[]
  /** A different shape would likely be better; said, explained, not proposed to run. */
  recommendations: ConcernAssessment[]
  /** Cohesive concerns with nothing yet showing they matter. Watched, not proposed. */
  watching: ConcernAssessment[]
  /**
   * Cohesive concerns deliberately left alone — counterproductive to move, or
   * held by memory (declined, undone, already in effect) — each with its reason.
   */
  held: ConcernAssessment[]
  /** Tables looked at hard and left alone on purpose, with the reason. */
  noChange: Array<{ table: string; reason: string }>
  tables: Array<Pick<TableAssessment, 'table' | 'rows' | 'coverage' | 'subject'> & { concerns: number }>
  limits: string[]
}

function clientMigration(spec: ExtractionSpec, fkColumn: string): ProposalView['clientMigration'] {
  const cols = spec.members.join(',')
  const first = spec.members[0]
  return [
    {
      purpose: 'read the concern with its parent',
      before: `GET /db/${spec.host}?select=id,${cols}`,
      after: `GET /db/${spec.host}?select=id,${spec.satellite}(${cols})`,
    },
    {
      purpose: 'record it',
      before: `PATCH /db/${spec.host}?id=eq.<id>  { "${first}": … }`,
      after: `POST /db/${spec.satellite}  { "${fkColumn}": "<id>", "${first}": … }`,
    },
    {
      purpose: 'remove it',
      before: `PATCH /db/${spec.host}?id=eq.<id>  { ${spec.members.map(m => `"${m}": null`).join(', ')} }`,
      after: `DELETE /db/${spec.satellite}?${fkColumn}=eq.<id>`,
    },
  ]
}

function stateOf(
  approval: Awaited<ReturnType<typeof readLatestEvolutionApproval>>,
  run: LedgerRun | null,
  planVersion: string,
): ProposalState {
  if (run?.status === 'rolled_back') return 'rolled_back'
  if (run?.status === 'completed') return 'extracted'
  if (run && ['running', 'awaiting_background_work'].includes(run.status)) return 'in_progress'
  if (run?.status === 'halted') return 'halted'
  if (approval && !approval.revokedAt && approval.planVersion === planVersion) return 'approved'
  return 'proposed'
}

/**
 * Analyse every table of a project and describe what should evolve.
 *
 * Bounded: at most MAX_TABLES tables, a capped row sample each, one read of the
 * snapshot series, one grouped read of the request log. Satellites this engine
 * created are not analysed as hosts.
 */
export async function analyzeStructuralEvolution(
  projectId: string,
  /**
   * `priors` is what architecture memory recalls per concern (see
   * lib/evolution-engine/memory.ts `priorsFor`): a change that was declined,
   * undone or is already in effect is not proposed again on the same evidence.
   */
  opts: { tables?: string[]; now?: Date; priors?: Record<string, PriorOutcome> } = {},
): Promise<EvolutionReport> {
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000)
  const schema = await resolveWorkspaceSchema(projectId)
  const all = await listBaseTables(schema)
  const names = (opts.tables ? all.filter(t => opts.tables!.includes(t)) : all).slice(0, MAX_TABLES)

  const [snapshots, repairs, requests, consumers] = await Promise.all([
    readSnapshots(projectId),
    readRepairs(projectId, since),
    readRequestsByTable(projectId, since),
    readProjectConsumers(projectId),
  ])

  const tables: TableAssessment[] = []
  for (const table of names) {
    const facts = await readTableFacts(schema, table)
    if (!facts) continue
    // A table holding a `bkn_evo_` foreign key is a satellite. It is the
    // answer to a previous proposal, not a host for the next one.
    if (facts.constraints.some(c => c.kind === 'f' && c.name.startsWith('bkn_evo_'))) continue

    const { eligible } = partitionColumns(facts)
    const sampled = eligible.length >= 2 ? await samplePresence(facts, eligible) : null
    tables.push(
      analyzeTable({
        facts,
        presence: sampled && 'sample' in sampled ? sampled.sample : null,
        presenceUnavailableReason:
          sampled === null ? 'fewer than two candidate columns to compare' : 'unavailable' in sampled ? sampled.unavailable : undefined,
        history: columnHistory(snapshots, table),
        pressure: {
          windowDays: WINDOW_DAYS,
          repairs: repairs.filter(r => r.table === table),
          hostRequests: requests ? requests.get(table) ?? 0 : null,
          consumers: consumersOf(consumers, table, facts.columns.map(c => c.name)),
          now,
        },
        priors: opts.priors,
      }),
    )
  }

  const proposals: ProposalView[] = []
  const recommendations: ConcernAssessment[] = []
  const watching: ConcernAssessment[] = []
  const held: ConcernAssessment[] = []

  for (const t of tables) {
    const facts = await readTableFacts(schema, t.table)
    if (!facts) continue
    for (const c of t.concerns) {
      const planId = extractionPlanId(projectId, c.host, c.members)
      const approval = await readLatestEvolutionApproval(projectId, planId)
      const run = await latestRun(projectId, planId)
      // The level decides; `fires` (the churn-blind gate) is one of its inputs.
      if (c.level !== 'executable_proposal' && !approval && !run) {
        if (c.level === 'recommendation_only') recommendations.push(c)
        else if (c.level === 'watching') watching.push(c)
        else if (c.cohesive) held.push(c)
        continue
      }

      // The owner's chosen name, once they have chosen one; the default before.
      const spec: ExtractionSpec = approval?.spec ?? {
        host: c.host,
        members: c.members,
        satellite: c.defaultSatellite,
        label: c.label,
      }
      const exists = await relationExists(schema, spec.satellite)
      const ours = exists ? isOurSatellite(await readTableFacts(schema, spec.satellite), spec) : false
      const plan = buildExtractionPlan({
        projectId,
        spec,
        facts,
        satelliteExists: exists && !ours,
        consumers: consumersOf(consumers, c.host, c.members),
      })

      proposals.push({
        ...c,
        planId,
        state: stateOf(approval, run, plan.planVersion),
        spec,
        plan: {
          planVersion: plan.planVersion,
          validity: plan.validity,
          blockedReasons: plan.blockedReasons,
          contractBlockers: plan.contractBlockers,
          caveats: plan.caveats,
          access: plan.access,
          steps: plan.steps,
          requiredTier: requiredTier(plan),
        },
        consent: approval
          ? {
              approvalId: approval.id,
              planVersion: approval.planVersion,
              approvedBy: approval.approvedBy,
              createdAt: approval.createdAt.toISOString(),
              revoked: approval.revokedAt !== null,
              current: approval.planVersion === plan.planVersion,
            }
          : null,
        lastRun: run
          ? { executionId: run.executionId, status: run.status, haltReason: run.haltReason, at: (run.completedAt ?? run.startedAt ?? run.createdAt).toISOString() }
          : null,
        clientMigration: clientMigration(spec, ladderNames(spec).fkColumn),
      })
    }
  }

  proposals.sort((a, b) => b.priority.score - a.priority.score || a.key.localeCompare(b.key))

  return {
    projectId,
    analyzedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    proposals,
    recommendations,
    watching,
    held,
    noChange: tables
      .filter(t => t.subject.noChangeReason !== null && t.subject.level === 'no_change_recommended')
      .map(t => ({ table: t.table, reason: t.subject.noChangeReason! })),
    tables: tables.map(t => ({ table: t.table, rows: t.rows, coverage: t.coverage, subject: t.subject, concerns: t.concerns.length })),
    limits: [
      'Readers that select columns in their own requests — PostgREST clients and direct connection strings — cannot be enumerated, so retiring the old columns is always a person\'s decision.',
      ...(all.length > MAX_TABLES ? [`Only the first ${MAX_TABLES} of ${all.length} tables were analysed.`] : []),
      ...(requests === null ? ['The request log could not be read, so no table was measured as busy.'] : []),
      ...(!Array.isArray(snapshots) ? [snapshots.unavailable] : []),
    ],
  }
}
