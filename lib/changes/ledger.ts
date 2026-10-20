/**
 * GOVERNED CHANGES
 * ================
 *
 * Every governed change to a project's production backend runs inside
 * `withGovernedChange`, which gives it a recoverable lifecycle
 * (docs/CHANGE_RECOVERY.md):
 *
 *   1. takes the project's change lock, so the change is the only thing
 *      altering the schema from its checkpoint until it is verified, and, if it
 *      fails, recovered (lib/changes/lock.ts);
 *   2. reads the catalog: the CHECKPOINT, taken before the first statement;
 *   3. opens a BackendChange row, status `applying`, so a change interrupted by
 *      a crash is still on record with its checkpoint;
 *   4. runs the change, capturing every mutating statement it sends
 *      (lib/execution/sql-recorder.ts) and giving destructive executors a vault
 *      to move data into instead of destroying it (lib/changes/preserve.ts);
 *   5. reads the catalog again and records the difference, object by object:
 *      the footprint. It is derived from the database, never from what the
 *      change said it did;
 *   6. runs PROTECTED VERIFICATION (lib/changes/verify.ts): checks the control
 *      plane defines and nothing in the request can reach;
 *   7. if the change failed part-way or failed verification, recovers it on the
 *      spot when that is provably lossless, and otherwise escalates it to a
 *      person (lib/changes/recovery.ts), still inside the same lock.
 *
 * Nested calls join the change already open for the project rather than
 * opening a second: an apply_migration of five statements dispatches five
 * typed actions, and is still one change with one checkpoint.
 *
 * A change that turns out to have altered nothing leaves no row.
 *
 * Who did it travels separately, in `withChangeAttribution`, set where the
 * identity is authenticated (the MCP route knows the agent's key, the approval
 * route knows the person) and read here, so no executor has to be told and no
 * caller can claim to be someone else.
 */

import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { installSqlRecorder, withSqlCapture, type RecordedStatement } from '@/lib/execution/sql-recorder'
import { pickTables, type CatalogSnapshot } from './catalog'
import { currentAttribution, type ChangeAttribution } from './attribution'
import { openChangeContext, type ChangeContext } from './context'
import { describeChange } from './describe'
import { diffCatalogs, footprintObjects, footprintTables } from './diff'
import { refreshSchemaViews, tablesTouched } from './freshness'
import { resultDataFor } from './impact'
import { checkpointHash } from './integrity'
import { recordEvent, transition } from './lifecycle'
import { readCatalogOn, withChangeLock } from './lock'
import { createVaultStatements, vaultSchemaName } from './names'
import {
  catalogStructure,
  forgetCatalogInRegion,
  keepCatalogInRegion,
  keptSteps,
  keptText,
  keptVerification,
  newCatalogKey,
  quotesKeptHere,
} from './residency'
import { verifyChange, type ChangeVerification, type Expectation } from './verify'
import type { ChangeKind, ChangePreservation, ChangeStatus, ChangeStep, PreservedEntry, RiskClass, TableChange } from './types'
import type { AutoRecoveryOutcome } from './recovery'

// ── Attribution ──────────────────────────────────────────────────────────────

export { withChangeAttribution, currentAttribution, type ChangeAttribution } from './attribution'

// ── The open change ──────────────────────────────────────────────────────────

export interface OpenChange extends ChangeContext {
  id: string
  seq: number
  kind: ChangeKind
  /** The workspace schema the change applies to. */
  schema: string
  /** This change's vault, created the first time something is moved into it. */
  vault: string
  /** The connection holding the change lock; idle while the change itself runs. */
  client: PoolClient
  /** The whole schema as it was when the change opened. */
  before: CatalogSnapshot
  /** Data moved into the vault instead of destroyed. */
  preserved: PreservedEntry[]
  /** Statements run on the lock's own connection, which the recorder does not see. */
  statements: string[]
  /** What each step said it would do, for protected verification. */
  expectations: Expectation[]
  /** Set by a recovery: its own verification, stored with its record. */
  verification?: ChangeVerification
  vaultCreated: boolean
}

/**
 * The change open for this project in the current async context, if any. Never
 * one whose work is over: a timer or promise started inside a change still
 * carries it after it closes, and work joined to it then is recorded nowhere.
 */
export function currentChange(projectId: string): OpenChange | null {
  // The ledger is the only writer of this context, and it writes OpenChanges.
  const c = openChangeContext.getStore() as OpenChange | undefined
  return c && c.projectId === projectId && !c.finished ? c : null
}

/** Create the change's vault on first use and return its name. */
export async function ensureVault(change: OpenChange): Promise<string> {
  if (!change.vaultCreated) {
    for (const sql of createVaultStatements(change.vault)) {
      recordStatement(change, sql)
      await change.client.query(sql)
    }
    change.vaultCreated = true
  }
  return change.vault
}

/** Put a statement run outside the recorder on the change's record. */
export function recordStatement(change: OpenChange, sql: string): void {
  change.statements.push(sql)
}

/** What a step reported it did, for protected verification to check. */
export function expectEffect(projectId: string, expectation: Expectation): void {
  currentChange(projectId)?.expectations.push(expectation)
}

// ── Recording ────────────────────────────────────────────────────────────────

export function ledgerEnabled(projectId: string): boolean {
  // Integration mode runs the executors against an in-memory graph and issues
  // no DDL, so there is nothing to record and no catalog to read.
  if (process.env.ENGINE_MODE === 'integration') return false
  if (process.env.BACKENLY_CHANGE_LEDGER === 'off') return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)
}

export interface ChangeVerdict {
  ok: boolean
  error?: string
  steps?: ChangeStep[]
}

export interface ClosedChange {
  id: string
  seq: number
  status: ChangeStatus
  summary: string
  footprint: TableChange[]
  verification: ChangeVerification | null
  /** For a change that failed: what Backenly did about it. */
  recovery?: AutoRecoveryOutcome
}

export interface GovernedChangeInput {
  projectId: string
  title: string
  /**
   * The title for a project kept outside the home region, when `title` quotes
   * the request (a migration's first statement): names and counts only
   * (lib/changes/residency.ts). Defaults to `title`, which most callers build
   * from names already.
   */
  regionalTitle?: string
  kind?: ChangeKind
  /** For a recovery: the change whose previous state it restores. */
  recoversId?: string
  /** For a recovery: its own one-line summary ("Restored the state before #12"). */
  summary?: string
  /** Recover automatically (when provably safe) if the change fails. Default: yes for a change. */
  autoRecover?: boolean
}

/** Thrown inside a change to abandon it without leaving a record. */
export class AbandonChange extends Error {
  constructor(readonly payload: unknown) {
    super('change abandoned')
    this.name = 'AbandonChange'
  }
}

/** Platform rows that describe tables, kept with the checkpoint and put back on restore. */
export interface PlatformState {
  /** Tables with a platform registry row. */
  registered: string[]
  /** Row-level security metadata, exactly as stored. */
  policies: Array<Record<string, unknown>>
}

export type StoredSnapshot = CatalogSnapshot & { platform?: PlatformState }

async function readPlatformState(projectId: string): Promise<PlatformState> {
  const [tables, policies] = await Promise.all([
    prisma.table.findMany({ where: { projectId }, select: { name: true } }),
    prisma.permissionPolicy.findMany({ where: { projectId } }),
  ])
  return {
    registered: tables.map((t) => t.name),
    policies: policies.map((p) => ({ ...p, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() })),
  }
}

function pickPlatform(state: PlatformState, tables: string[]): PlatformState {
  const names = new Set(tables)
  return {
    registered: state.registered.filter((t) => names.has(t)),
    policies: state.policies.filter((p) => names.has(String(p.tableName))),
  }
}

/**
 * The checkpoint as the record keeps it. For a project kept outside the home
 * region the definitions stay there (lib/changes/residency.ts): the record
 * keeps the catalog's structure, each definition as its digest under `key`,
 * and says the definitions are in the region.
 */
function keptCheckpoint(database: StoredSnapshot, key: string | null): Prisma.InputJsonValue {
  return (key ? { database: catalogStructure(database, key), definitionsInRegion: true } : { database }) as unknown as Prisma.InputJsonValue
}

/**
 * `key` is null for a project in the home region, whose record keeps the
 * catalog as it is.
 */
async function allocateRow(input: GovernedChangeInput, attr: ChangeAttribution, checkpoint: StoredSnapshot, key: string | null) {
  const quote = key === null
  // The region holds the definitions before any record digests them.
  const id = randomUUID()
  if (key) await keepCatalogInRegion(input.projectId, id, { key, opened: checkpoint })
  try {
    // seq is MAX+1 under the change lock, which serialises every writer for this
    // project; the retry covers a writer from before this code shipped.
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = await prisma.backendChange.findFirst({
        where: { projectId: input.projectId },
        orderBy: { seq: 'desc' },
        select: { id: true, seq: true },
      })
      try {
        return await prisma.backendChange.create({
          data: {
            id,
            projectId: input.projectId,
            seq: (last?.seq ?? 0) + 1,
            kind: input.kind ?? 'change',
            source: attr.source,
            title: (quote ? input.title : input.regionalTitle ?? input.title).slice(0, 300),
            actorUserId: attr.actorUserId ?? null,
            apiKeyId: attr.apiKeyId ?? null,
            groupId: attr.groupId ?? null,
            parentId: last?.id ?? null,
            status: 'applying',
            checkpoint: keptCheckpoint(checkpoint, key),
            recoversId: input.recoversId ?? null,
          },
          select: { id: true, seq: true, parentId: true, createdAt: true },
        })
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err
      }
    }
    throw new Error('Could not allocate a change number after three attempts.')
  } catch (err) {
    // No record was written, so nothing digests what the region was given.
    if (key) await forgetCatalogInRegion(input.projectId, id).catch(() => {})
    throw err
  }
}

/**
 * What a change did, from the catalog before and after it. Values rewritten in
 * place leave no trace in the catalog, so the tables holding them are named
 * from what the change preserved.
 */
function footprintBetween(before: CatalogSnapshot, after: CatalogSnapshot, preserved: PreservedEntry[]): TableChange[] {
  const footprint = diffCatalogs(before, after)
  const rewritten = new Map<string, string[]>()
  for (const e of preserved) {
    if (e.kind === 'column' && e.reason === 'rewritten') rewritten.set(e.table, [...(rewritten.get(e.table) ?? []), e.column])
  }
  for (const [table, cols] of rewritten) {
    const entry = footprint.find((c) => !c.object && c.after === table)
    if (entry) entry.details.push(`values rewritten in ${cols.join(', ')}`)
    else footprint.push({ kind: 'modified', before: table, after: table, details: [`values rewritten in ${cols.join(', ')}`] })
  }
  return footprint
}

/** How much protection the change needed, from what it did. */
export function classifyRisk(footprint: TableChange[], preserved: PreservedEntry[]): RiskClass {
  if (preserved.some((e) => e.kind === 'column' && e.reason === 'rewritten')) return 'data_rewrite'
  if (
    preserved.some((e) => e.kind === 'table' || (e.kind === 'column' && e.reason === 'dropped')) ||
    footprint.some((c) => c.kind === 'removed' || c.details.some((d) => d.startsWith('− column')))
  ) {
    return 'destructive'
  }
  // Removing an index, a constraint, a policy or a trigger removes no data but
  // creates nothing either: it changes what the schema guarantees, so it is
  // transforming. It used to fall through to additive.
  if (footprint.some((c) => c.kind === 'replaced' || c.details.some((d) => d.startsWith('~') || d.startsWith('− ') || d.includes('renamed')))) {
    return 'transforming'
  }
  return 'additive'
}

/**
 * Run `fn` as one governed change to the project's production backend.
 *
 * `judge` turns the result into success or failure, for callers that report
 * failure by value rather than by throwing (an executor's `{ success: false }`).
 * A thrown error is recorded and rethrown.
 */
export async function withGovernedChange<T>(
  input: GovernedChangeInput,
  fn: () => Promise<T>,
  judge?: (result: T) => ChangeVerdict,
): Promise<{ result: T; change: ClosedChange | null }> {
  const { projectId } = input
  if (currentChange(projectId)) return { result: await fn(), change: null }
  if (!ledgerEnabled(projectId)) return { result: await fn(), change: null }

  // The statements are captured where they are sent: the home client, and the
  // client of the project's own region, which is a different one for a project
  // kept outside the home region (lib/data-plane/regional.ts).
  installSqlRecorder(prisma as any)
  const { workspaceRawClient } = await import('@/lib/data-plane/regional')
  installSqlRecorder((await workspaceRawClient(projectId)) as any)

  return withChangeLock(projectId, async (client) => {
    const { resolveWorkspaceSchema } = await import('@/lib/services/workspace-pool')
    const schema = await resolveWorkspaceSchema(projectId)
    const attr: ChangeAttribution = currentAttribution() ?? { source: 'system' }
    const kind = input.kind ?? 'change'

    const before = await readCatalogOn(client, schema)
    const platform = await readPlatformState(projectId)
    // Whether this record may quote the work's text (lib/changes/residency.ts).
    // When it may not, the catalogs' definitions are kept in the region and
    // this record digests them under a key kept there with them.
    const quote = await quotesKeptHere(projectId)
    const key = quote ? null : newCatalogKey()
    const row = await allocateRow(input, attr, before, key)
    const discard = async () => {
      await prisma.backendChange.delete({ where: { id: row.id } }).catch(() => {})
      if (key) await forgetCatalogInRegion(projectId, row.id).catch(() => {})
    }

    const change: OpenChange = {
      projectId,
      id: row.id,
      seq: row.seq,
      kind,
      schema,
      vault: vaultSchemaName(projectId, row.seq),
      client,
      before,
      preserved: [],
      statements: [],
      expectations: [],
      vaultCreated: false,
      finished: false,
    }

    let result: T | undefined
    let thrown: unknown = null
    let captured: RecordedStatement[] = []
    try {
      const out = await withSqlCapture(() => openChangeContext.run(change, fn))
      result = out.result
      captured = out.statements
    } catch (err) {
      thrown = err
    }
    // Its work is over. Anything it started that is still running (a timer, an
    // unawaited promise) still carries it, and must open a change of its own.
    change.finished = true

    if (thrown instanceof AbandonChange) {
      await discard()
      throw thrown
    }

    const after = await readCatalogOn(client, schema)
    const footprint = footprintBetween(before, after, change.preserved)
    // What the record keeps of it. Outside the home region, the same lines
    // from the catalogs' structure, which name definitions without quoting
    // them: equal definitions digest equal under one key.
    const keptFootprint = key ? footprintBetween(catalogStructure(before, key), catalogStructure(after, key), change.preserved) : footprint

    const verdict: ChangeVerdict = thrown
      ? { ok: false, error: thrown instanceof Error ? thrown.message : String(thrown) }
      : judge
        ? judge(result as T)
        : { ok: true }

    // Nothing changed and nothing was kept: a no-op is not worth a row. (A
    // failure that touched nothing is: someone asked, and it was refused.)
    if (footprint.length === 0 && change.preserved.length === 0 && verdict.ok && !change.verification) {
      await discard()
      if (thrown) throw thrown
      return { result: result as T, change: null }
    }

    const statements = [
      ...captured.map((s) => ({ sql: s.sql, ...(s.params ? { params: s.params } : {}) })),
      ...change.statements.map((sql) => ({ sql })),
    ]
    const tables = footprintTables(footprint)
    const objects = footprintObjects(footprint)
    const touchedBefore = pickTables(before, tables.before, objects.before)
    const touchedAfter = pickTables(after, tables.after, objects.after)
    // Outside the home region the definitions go to the region first, the
    // whole catalog the change opened with still beside them until the record
    // below is trimmed to match (definitionsFromRegion checks whichever the
    // record holds).
    if (key) await keepCatalogInRegion(projectId, change.id, { key, opened: before, checkpoint: touchedBefore, resultState: touchedAfter })
    const kept = <S extends CatalogSnapshot>(snapshot: S): S => (key ? catalogStructure(snapshot, key) : snapshot)
    const checkpoint = {
      database: { ...kept(touchedBefore), platform: pickPlatform(platform, tables.before) },
      ...(key ? { definitionsInRegion: true } : {}),
    }
    const added = footprint.filter((c) => !c.object && (c.kind === 'added' || c.kind === 'replaced') && c.after).map((c) => ({ name: c.after! }))
    const resultState = {
      ...kept(touchedAfter),
      data: await resultDataFor({ query: (sql, params) => client.query(sql, params as unknown[]) }, schema, added),
    }
    const preserved: ChangePreservation | null = change.preserved.length > 0 ? { vault: change.vault, entries: change.preserved } : null
    const summary = input.summary ?? describeChange(keptFootprint)
    const evidence = {
      steps: keptSteps(verdict.steps, quote) as unknown as Prisma.InputJsonValue,
      // For a project kept in another region the SQL stays there: it can carry values.
      statements: (quote ? statements : []) as unknown as Prisma.InputJsonValue,
      checkpoint: checkpoint as unknown as Prisma.InputJsonValue,
      resultState: resultState as unknown as Prisma.InputJsonValue,
      footprint: keptFootprint as unknown as Prisma.InputJsonValue,
      preserved: preserved ? (preserved as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      summary: summary.slice(0, 300),
      risk: classifyRisk(footprint, change.preserved),
    }
    const hash = checkpointHash({ checkpoint, resultState, footprint: keptFootprint })
    const principals = {
      requestedBy: attr.apiKeyId ? { kind: 'agent', apiKeyId: attr.apiKeyId } : attr.actorUserId ? { kind: 'user', userId: attr.actorUserId } : { kind: 'backenly' },
      executedBy: { kind: 'backenly' },
    }
    await recordEvent(change.id, projectId, 'checkpointed', { at: row.createdAt.toISOString(), parentId: row.parentId, risk: evidence.risk, ...principals })

    let status: ChangeStatus
    let verification: ChangeVerification | null = null
    if (!verdict.ok) {
      status = footprint.length === 0 && change.preserved.length === 0 ? 'failed' : 'partially_applied'
      await transition(change.id, ['applying'], status, {
        ...evidence,
        error: keptText(verdict.error ?? 'failed', quote).slice(0, 2000),
        checkpointHash: hash,
        completedAt: new Date(),
      })
      await recordEvent(change.id, projectId, status === 'failed' ? 'apply_failed' : 'partially_applied', {
        error: keptText(verdict.error ?? 'failed', quote).slice(0, 500),
        objects: footprint.length,
      })
    } else {
      await transition(change.id, ['applying'], 'verifying', evidence)
      await recordEvent(change.id, projectId, 'applied', { objects: footprint.length, statements: statements.length })
      verification = kind === 'recovery'
        ? (change.verification ?? { outcome: 'inconclusive', checkedAt: new Date().toISOString(), checks: [] })
        : await verifyChange({
            schema,
            before,
            after,
            footprint,
            statements: statements.map((s) => s.sql),
            expectations: change.expectations,
            source: attr.source,
            client,
          })
      status = verification.outcome === 'confirmed' ? 'healthy' : verification.outcome === 'contradicted' ? 'verification_failed' : 'unverified'
      await transition(change.id, ['verifying'], status, {
        verification: keptVerification(verification, quote) as unknown as Prisma.InputJsonValue,
        checkpointHash: hash,
        completedAt: new Date(),
      })
      const failing = keptVerification(verification, quote).checks.filter((c) => c.outcome !== 'confirmed').map((c) => ({ id: c.id, outcome: c.outcome, detail: c.detail }))
      await recordEvent(
        change.id,
        projectId,
        status === 'healthy' ? 'verified' : status === 'unverified' ? 'verification_inconclusive' : 'verification_failed',
        { checks: verification.checks.length, ...(failing.length ? { failing } : {}) },
      )
    }

    // The record is trimmed now: the region no longer needs the whole catalog.
    if (key) await keepCatalogInRegion(projectId, change.id, { key, checkpoint: touchedBefore, resultState: touchedAfter }).catch(() => {})

    // Whatever its outcome, a change that touched the schema leaves every
    // cached view of it behind: the REST API's, the reconciler's baseline, this
    // process's table caches (lib/changes/freshness.ts). A recovery refreshes
    // them again where it settles.
    if (kind === 'change' && (footprint.length > 0 || change.preserved.length > 0)) {
      await refreshSchemaViews(projectId, tablesTouched(footprint))
    }

    const closed: ClosedChange = { id: change.id, seq: change.seq, status, summary, footprint, verification }

    if (kind === 'change' && input.autoRecover !== false && (status === 'partially_applied' || status === 'verification_failed')) {
      const { recoverAutomatically } = await import('./recovery')
      closed.recovery = await recoverAutomatically(projectId, change.id)
      closed.status = closed.recovery.status
    }

    if (thrown) throw thrown
    return { result: result as T, change: closed }
  })
}
