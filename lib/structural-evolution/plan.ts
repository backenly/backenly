/**
 * THE EXTRACTION LADDER — a concern leaves its table without anybody noticing
 * ===========================================================================
 *
 * A behaviour-preserving refactoring in the strict sense: after every rung,
 * every client that worked before still works, reads what it read and writes
 * where it wrote. What changes is that a second, better-shaped home for the
 * concern exists beside the first and is kept identical to it, so new code can
 * move over at its own pace and old code never has to.
 *
 *   0  rehearse         run the whole forward ladder against a copy of real
 *                       rows, inside a transaction that is always rolled back
 *   1  create_satellite the new table — closed, constrained, empty
 *   2  sync_forward     every write to the host is mirrored into it
 *   3  backfill         the rows that already existed, in resumable batches
 *   4  verify           the two agree, at one snapshot, row for row
 *   5  expose_reads     readable by exactly those who can read the parent
 *   6  open_writes      writable by exactly those who can update the parent;
 *                       writes flow back so old clients still see them
 *   7  verify           still identical with both directions live
 *   8  contract         drop the old columns — a person's decision, never ours
 *
 * ── Consent binds to SQL, not to a description ──────────────────────────────
 *
 * The maintenance planner emits abstract parameters and takes the concrete
 * column from the approval's bindings. Here every rung is fully concrete at
 * planning time — the spec names real identifiers and the facts supply real
 * types — so the plan hashes the rendered statements themselves into
 * `planVersion`. Approving version N is approving those exact statements. If
 * the host's shape, its grants, the satellite's name or the executor's
 * capability table move, the text moves, the version moves, and consent does
 * not carry over.
 *
 * ── What is NOT part of a plan ──────────────────────────────────────────────
 *
 * Evidence. Sampled presence rates, change counts and traffic explain why a
 * proposal exists and are never hashed. A plan is a pure function of a spec and
 * the catalog, so the executor can rebuild it at the moment of mutation and
 * compare — the only staleness check that cannot be a tautology.
 */

import { createHash } from 'node:crypto'
import { basisFingerprint, granteesWith, type TableFacts } from './facts'
import { readName } from './lexicon'
import {
  carriedObjects,
  closeWritesSql,
  contractSql,
  createSatelliteSql,
  dropForwardSyncSql,
  dropSatelliteSql,
  exposeReadsSql,
  forwardSyncSql,
  ladderNames,
  backfillBatchSql,
  openWritesSql,
  reconcileSql,
  revokeReadsSql,
  specProblem,
  type ExtractionSpec,
  type RenderTarget,
} from './sql'
import { assessSeparability, type Consumer } from './concerns'

export type ExtractionStepKind =
  | 'rehearse'
  | 'create_satellite'
  | 'sync_forward'
  | 'backfill'
  | 'verify'
  | 'expose_reads'
  | 'open_writes'
  | 'contract'

export type Capability = 'implemented' | 'not_implemented' | 'human_only'

/**
 * What this deployment's executor can do, per rung.
 *
 * Hashed into every plan version for the kinds that plan uses, for the reason
 * the maintenance table is: a ladder approved while a rung could not run must
 * not silently become runnable when the rung lands.
 *
 * The revision suffix moves when a handler's behaviour changes materially while
 * staying implemented — a boolean cannot express that, and it is exactly the
 * change an approver would want to re-read.
 */
export const EXTRACTION_CAPABILITY: Readonly<Record<ExtractionStepKind, `${Capability}@${number}`>> = {
  rehearse: 'implemented@1',
  create_satellite: 'implemented@1',
  sync_forward: 'implemented@1',
  backfill: 'implemented@1',
  verify: 'implemented@1',
  expose_reads: 'implemented@1',
  open_writes: 'implemented@1',
  contract: 'human_only@1',
}

export const capabilityOf = (k: ExtractionStepKind): Capability =>
  EXTRACTION_CAPABILITY[k].split('@')[0] as Capability

export type RollbackStrategy =
  | 'none_required'
  | 'drop_satellite'
  | 'drop_forward_sync'
  | 'covered_by_drop_satellite'
  | 'revoke_reads'
  | 'close_writes'

export interface ExtractionStep {
  ordinal: number
  kind: ExtractionStepKind
  /** 0 reads, 1 additive and closed, 2 changes behaviour, 3 irreversible. */
  tier: 0 | 1 | 2 | 3
  capability: Capability
  title: string
  why: string
  /** The exact statements. For `backfill`, one batch's template. */
  sql: string[]
  preconditions: string[]
  postconditions: string[]
  rollback: { strategy: RollbackStrategy; description: string; sql: string[] } | null
  idempotencyKey: string
}

export type PlanValidity = 'executable' | 'blocked_by_capability' | 'invalid'

export interface ExtractionPlan {
  projectId: string
  planId: string
  planVersion: string
  /** Ledger key. Stored where the maintenance ledger keeps its finding id. */
  proposalKey: string
  spec: ExtractionSpec
  schema: string
  basisFingerprint: string
  steps: ExtractionStep[]
  validity: PlanValidity
  blockedReasons: string[]
  /** What a person must migrate before `contract`. Never blocks the ladder. */
  contractBlockers: string[]
  caveats: string[]
  /** Roles that will be able to read / write the satellite, mirrored from the host. */
  access: { readers: string[]; writers: string[] }
  createdAt: string
}

export const BACKFILL_BATCH_ROWS = 1_000

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16)

export function extractionPlanId(projectId: string, host: string, members: string[]): string {
  return hash(['evolution', projectId, host, [...members].sort()])
}

export function proposalKeyFor(host: string, members: string[]): string {
  return `evolution:${host}:${[...members].sort().join('+')}`
}

export interface PlanInput {
  projectId: string
  spec: ExtractionSpec
  facts: TableFacts
  /** Does a relation with the satellite's name already exist? Read by the caller. */
  satelliteExists: boolean
  consumers?: Consumer[]
}

/**
 * Build the ladder, or explain why there is none.
 *
 * Always returns a plan. "We looked and declined, for these reasons" is an
 * answer the owner is entitled to, and a null would throw it away.
 */
export function buildExtractionPlan(input: PlanInput): ExtractionPlan {
  const { projectId, facts } = input
  const spec: ExtractionSpec = { ...input.spec, members: [...input.spec.members].sort() }
  const target: RenderTarget = { schema: facts.schema }
  const planId = extractionPlanId(projectId, spec.host, spec.members)
  const blocked: string[] = []
  const invalid: string[] = []

  const problem = specProblem(spec)
  if (problem) invalid.push(problem)
  if (facts.table !== spec.host) invalid.push(`facts are for ${facts.table}, not ${spec.host}`)
  const missing = spec.members.filter(m => !facts.columns.some(c => c.name === m))
  if (missing.length > 0) invalid.push(`${spec.host} has no column ${missing.join(', ')}`)
  if (input.satelliteExists) {
    invalid.push(`a relation named ${spec.satellite} already exists; choose another name for the new table`)
  }

  const separability = assessSeparability(facts, spec.members, input.consumers ?? [])
  invalid.push(...separability.expandBlockers)

  // A list squeezed into numbered columns is a real proposal with the wrong
  // ladder: it wants one ROW per number, which is an unpivot, not a split.
  // Planned, shown, and honestly blocked until that rung exists.
  const ordinals = new Map<string, Set<number>>()
  for (const m of spec.members) {
    const r = readName(m, null)
    if (r.ordinal !== null && r.ordinalBase) ordinals.set(r.ordinalBase, (ordinals.get(r.ordinalBase) ?? new Set()).add(r.ordinal))
  }
  if ([...ordinals.values()].some(s => s.size >= 2)) {
    blocked.push(
      'these columns are numbered copies of one field; they need an unpivot ladder (one row per number), ' +
        'which this executor does not implement yet',
    )
  }

  const readers = granteesWith(facts, 'SELECT')
  const writers = granteesWith(facts, 'UPDATE').filter(r => readers.includes(r))
  const base = {
    projectId,
    planId,
    proposalKey: proposalKeyFor(spec.host, spec.members),
    spec,
    schema: facts.schema,
    basisFingerprint: basisFingerprint(facts),
    contractBlockers: separability.contractBlockers,
    access: { readers, writers },
    createdAt: new Date().toISOString(),
  }

  if (invalid.length > 0) {
    return {
      ...base,
      planVersion: hash([planId, 'invalid', invalid]),
      steps: [],
      validity: 'invalid',
      blockedReasons: invalid,
      caveats: separability.caveats,
    }
  }

  const names = ladderNames(spec)
  const carried = carriedObjects(facts, spec, names, target, { includeForeignKeys: true })
  const sat = `${spec.satellite}`
  const cols = spec.members.join(', ')
  const verifyStep = (why: string): Omit<ExtractionStep, 'ordinal' | 'idempotencyKey'> => ({
    kind: 'verify',
    tier: 0,
    capability: capabilityOf('verify'),
    title: `Prove ${sat} and ${spec.host} agree`,
    why,
    sql: [reconcileSql(facts, spec, target)],
    preconditions: [`${sat} exists`],
    postconditions: ['no host row is missing its satellite row, no satellite row is orphaned, no values differ'],
    rollback: { strategy: 'none_required', description: 'Reads only.', sql: [] },
  })

  const seeds: Array<Omit<ExtractionStep, 'ordinal' | 'idempotencyKey'>> = [
    {
      kind: 'rehearse',
      tier: 0,
      capability: capabilityOf('rehearse'),
      title: 'Rehearse on a copy of real rows',
      why:
        'Runs steps 1–4 and 6 against a sample of this table copied into a scratch schema, exercises inserts, ' +
        'updates, clears, deletes and writes through the new table, and reconciles after each — all inside one ' +
        'transaction that is always rolled back. Nothing it does is ever visible.',
      sql: [],
      preconditions: [`${spec.host} is readable`],
      postconditions: ['every exercise reconciled with zero differences'],
      rollback: { strategy: 'none_required', description: 'Rolled back by construction.', sql: [] },
    },
    {
      kind: 'create_satellite',
      tier: 1,
      capability: capabilityOf('create_satellite'),
      title: `Create ${sat}`,
      why:
        `A new table for the ${spec.label} concern: ${cols}, plus a unique reference to ${spec.host}. ` +
        'It starts closed — row-level security forced, every grant revoked — so creating it changes nothing anybody can see.',
      sql: createSatelliteSql(facts, spec, target, carried, planId),
      preconditions: [`no relation named ${sat} exists`, `${spec.host} has a single-column primary key`],
      postconditions: [`${sat} exists with ${spec.members.length} member column(s)`, 'row-level security is forced', 'no role but the owner holds a grant'],
      rollback: {
        strategy: 'drop_satellite',
        description:
          `Drop ${sat}. Refused unless reconciliation first shows it holds nothing ${spec.host} does not also hold, ` +
          'so undoing it can never lose a write.',
        sql: dropSatelliteSql(spec, target),
      },
    },
    {
      kind: 'sync_forward',
      tier: 2,
      capability: capabilityOf('sync_forward'),
      title: `Mirror every write to ${spec.host} into ${sat}`,
      why:
        'An AFTER trigger in the same transaction as the write. It cannot abort the customer\'s write: an error ' +
        'inside it is recorded and swallowed, and reconciliation is what proves it never happened.',
      sql: forwardSyncSql(facts, spec, target),
      preconditions: [`${sat} exists`],
      postconditions: [`a trigger on ${spec.host} keeps ${sat} in step`],
      rollback: { strategy: 'drop_forward_sync', description: 'Drop the trigger and its function.', sql: dropForwardSyncSql(spec, target) },
    },
    {
      kind: 'backfill',
      tier: 2,
      capability: capabilityOf('backfill'),
      title: `Copy existing ${spec.label} data into ${sat}`,
      why:
        `Batches of ${BACKFILL_BATCH_ROWS} rows in key order, each holding a share lock on its own rows only, ` +
        'resumable from the last key, retried by the job queue.',
      sql: [backfillBatchSql(facts, spec, target, BACKFILL_BATCH_ROWS)],
      preconditions: ['the forward sync is installed'],
      postconditions: ['every pre-existing row is represented'],
      rollback: {
        strategy: 'covered_by_drop_satellite',
        description: `Undone with ${sat} itself; the host is never written by a backfill.`,
        sql: [],
      },
    },
    verifyStep('Nothing is opened to clients until the two representations are shown to be identical.'),
    {
      kind: 'expose_reads',
      tier: 2,
      capability: capabilityOf('expose_reads'),
      title: `Let clients read ${sat}`,
      why:
        `A row of ${sat} is visible exactly when its ${spec.host} row is: the policy evaluates ${spec.host}'s own ` +
        `policies. SELECT is granted to ${readers.length ? readers.join(', ') : 'no role'} — the roles that can read ${spec.host}.`,
      sql: exposeReadsSql(facts, spec, target, readers),
      preconditions: ['reconciliation passed'],
      postconditions: [`${sat} is readable by the roles that can read ${spec.host}, under its parent's row rules`],
      rollback: {
        strategy: 'revoke_reads',
        description: 'Drop the read policy and revoke exactly the grants this rung made.',
        sql: revokeReadsSql(spec, target, readers),
      },
    },
    {
      kind: 'open_writes',
      tier: 2,
      capability: capabilityOf('open_writes'),
      title: `Let clients write ${spec.label} data through ${sat}`,
      why:
        `Every write to ${sat} is applied to ${spec.host} in the same statement, as the caller, so ${spec.host}'s ` +
        'update policy still decides who may change it, and clients still reading the old columns see the change. ' +
        `Granted to ${writers.length ? writers.join(', ') : 'no role'} — the roles that can update ${spec.host}.`,
      sql: openWritesSql(facts, spec, target, writers),
      preconditions: ['reads are exposed', 'reconciliation passed'],
      postconditions: [`writes to ${sat} reach ${spec.host} or are refused`],
      rollback: {
        strategy: 'close_writes',
        description:
          'Revoke the write grants, drop the write policies and the reverse sync. Lossless: every write it allowed ' +
          `was applied to ${spec.host} in the same statement.`,
        sql: closeWritesSql(spec, target, writers),
      },
    },
    verifyStep('Proves the two-way sync left both representations identical.'),
    {
      kind: 'contract',
      tier: 3,
      capability: capabilityOf('contract'),
      title: `Retire ${spec.host}.${cols}`,
      why:
        'Dropping the old columns requires knowing nothing reads them. PostgREST clients and connection strings ' +
        'choose their own columns and cannot be enumerated, so this is a person\'s decision, made after migrating ' +
        'everything listed under contract blockers. Backenly never runs it.',
      sql: contractSql(facts, spec, target),
      preconditions: ['every contract blocker is resolved', 'an observation window passed with no reads of the old columns'],
      postconditions: [`${spec.host} no longer carries the ${spec.label} concern`],
      rollback: null,
    },
  ]

  const steps: ExtractionStep[] = seeds.map((s, i) => ({ ...s, ordinal: i, idempotencyKey: '' }))

  const usedKinds = [...new Set(steps.map(s => s.kind))].sort()
  const planVersion = hash([
    planId,
    spec.satellite,
    base.basisFingerprint,
    steps.map(s => [s.kind, s.tier, s.sql, s.rollback?.sql ?? null]),
    usedKinds.map(k => `${k}:${EXTRACTION_CAPABILITY[k]}`),
  ])
  for (const s of steps) s.idempotencyKey = hash(['evo-step', planVersion, s.ordinal, s.kind])

  return {
    ...base,
    planVersion,
    steps,
    validity: blocked.length > 0 ? 'blocked_by_capability' : 'executable',
    blockedReasons: blocked,
    caveats: [...separability.caveats, ...carried.notCarried],
  }
}

/** Highest tier among the rungs software runs. `contract` is never one of them. */
export function requiredTier(plan: ExtractionPlan): number {
  return Math.max(0, ...plan.steps.filter(s => s.capability === 'implemented').map(s => s.tier))
}
