/**
 * PRIMITIVES — one rung at a time, each proven from the catalog afterwards
 * =======================================================================
 *
 * Each rung runs its statements in ONE transaction, with a short lock timeout,
 * as the platform. All-or-nothing per rung: a CREATE TABLE whose RLS statement
 * failed must not leave an open table behind, so the table and its closed-door
 * policy commit together or not at all.
 *
 * ── Success is read back, not assumed ───────────────────────────────────────
 *
 * The statements finishing without an error is not the claim a rung makes. The
 * claim is a property of the catalog — "the satellite exists, its row security
 * is forced, nobody but its owner holds a grant" — and each rung reads the
 * catalog after committing and refuses to report success unless the property
 * holds. CREATE TRIGGER reporting no error and the trigger existing are
 * different facts, and this codebase has already shipped the gap between them
 * once.
 *
 * ── Locks ───────────────────────────────────────────────────────────────────
 *
 * Two rungs lock the HOST briefly: the foreign key in `create_satellite` takes
 * SHARE ROW EXCLUSIVE on it, and so does `CREATE TRIGGER` in `sync_forward`.
 * Both block writers for as long as the DDL takes, which is milliseconds — but
 * WAITING for that lock queues every later writer behind the wait. So the lock
 * timeout is short and a busy table makes the rung fail and retry, rather than
 * stall checkout traffic while it waits its turn.
 */

import { prisma } from '@/lib/db'
import { enqueue } from '@/lib/queue'
import { createHash } from 'node:crypto'
import { readTableFacts, relationExists, type TableFacts } from './facts'
import { ladderNames, type ExtractionSpec } from './sql'
import { reconcileExtraction } from './reconcile'
import { rehearseExtraction } from './rehearse'
import { inFlightChain } from './backfill-job'
import type { ExtractionPlan, ExtractionStep } from './plan'

export const LOCK_TIMEOUT_MS = 3_000
export const STATEMENT_TIMEOUT_MS = 60_000

export interface StepRunResult {
  status: 'completed' | 'dispatched' | 'failed'
  detail: string
  backgroundJobId?: string
  /** Evidence for the ledger's `result`. */
  evidence?: Record<string, unknown>
  /** What the catalog shows afterwards. Rollback's stale guard compares against this. */
  observed?: Record<string, unknown>
}

export async function runStatements(statements: string[]): Promise<void> {
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  await prisma.$transaction(
    async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`)
      await tx.$executeRawUnsafe(
        rlsSessionSql(1),
        ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }),
      )
      for (const s of statements) await tx.$executeRawUnsafe(s)
    },
    { timeout: STATEMENT_TIMEOUT_MS + 10_000, maxWait: 10_000 },
  )
}

/** Is this relation the satellite THIS spec creates, and not a namesake? */
export function isOurSatellite(sat: TableFacts | null, spec: ExtractionSpec): boolean {
  if (!sat) return false
  const n = ladderNames(spec)
  return sat.constraints.some(c => c.name === n.fk && c.kind === 'f' && c.refTable === spec.host)
}

const sha = (s: string | null) => (s ? createHash('sha256').update(s).digest('hex').slice(0, 16) : null)
const nonOwnerGrants = (f: TableFacts) => f.grants.filter(g => g.grantee !== f.owner)

/**
 * Ask PostgREST to rebuild its schema cache so the new table — or its absence —
 * is visible to clients. Best-effort and reported: the platform function only
 * exists where the data plane is provisioned, and NOTIFY is the protocol it
 * wraps.
 */
export async function reloadDataPlane(): Promise<string> {
  try {
    await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_reload()`)
    return 'schema cache reloaded'
  } catch {
    try {
      await prisma.$executeRawUnsafe(`NOTIFY pgrst, 'reload schema'`)
      return 'schema cache reload requested'
    } catch (err) {
      return `schema cache not reloaded: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

async function registerTable(projectId: string, schema: string, name: string, description: string): Promise<void> {
  await prisma.table
    .upsert({
      where: { name_schema_projectId: { name, schema, projectId } },
      create: { projectId, name, schema, description },
      update: {},
    })
    .catch(() => {})
}

export async function unregisterTable(projectId: string, schema: string, name: string): Promise<void> {
  await prisma.table.deleteMany({ where: { projectId, schema, name } }).catch(() => {})
}

/**
 * Is this rung's effect already present, from an attempt the ledger never heard
 * finish?
 *
 * A rung commits its own transaction and the ledger records it afterwards; a
 * crash between the two leaves the row `running` over a change that happened.
 * Every rung but one is idempotent and is simply run again. `create_satellite`
 * is not — CREATE TABLE refuses a table that exists, which is exactly what makes
 * it safe against namesakes — so it is ADOPTED instead, and only when the table
 * is unmistakably the one this rung creates: our foreign key by its hashed
 * name, closed exactly as the rung leaves it, every member column present, the
 * truncate guard in place.
 */
export async function rungAlreadyApplied(plan: ExtractionPlan, step: ExtractionStep): Promise<StepRunResult | null> {
  if (step.kind !== 'create_satellite') return null
  const { spec, schema } = plan
  const sat = await readTableFacts(schema, spec.satellite)
  if (!sat || !isOurSatellite(sat, spec)) return null
  const n = ladderNames(spec)
  const closed =
    sat.rowSecurity &&
    sat.forceRowSecurity &&
    nonOwnerGrants(sat).length === 0 &&
    spec.members.every(m => sat.columns.some(c => c.name === m)) &&
    sat.triggers.some(t => t.name === n.truncateGuard)
  if (!closed) return null
  return {
    status: 'completed',
    detail: `${spec.satellite} was created by an attempt that stopped before recording it (oid ${sat.oid}); adopted`,
    observed: { kind: 'satellite', oid: sat.oid, columns: sat.columns.map(c => `${c.name}:${c.type}`), adopted: true },
  }
}

// ── Rungs ────────────────────────────────────────────────────────────────────

export async function runStep(projectId: string, plan: ExtractionPlan, step: ExtractionStep): Promise<StepRunResult> {
  const { spec, schema } = plan
  const n = ladderNames(spec)
  const host = await readTableFacts(schema, spec.host)
  if (!host) return { status: 'failed', detail: `${spec.host} no longer exists` }

  switch (step.kind) {
    case 'rehearse': {
      const r = await rehearseExtraction(host, spec, plan.planId)
      const failedNames = r.exercises.filter(e => e.outcome === 'failed').map(e => `${e.name}: ${e.detail}`)
      return r.passed
        ? {
            status: 'completed',
            detail:
              `rehearsed on ${r.sampledRows} copied row(s): ${r.exercises.filter(e => e.outcome === 'passed').length} exercise(s) ` +
              `reconciled with zero differences, ${r.exercises.filter(e => e.outcome === 'not_exercised').length} not applicable`,
            evidence: { rehearsal: r },
          }
        : {
            status: 'failed',
            detail: r.error ? `rehearsal could not run: ${r.error}` : `rehearsal failed: ${failedNames.join('; ') || 'no exercise passed'}`,
            evidence: { rehearsal: r },
          }
    }

    case 'create_satellite': {
      if (await relationExists(schema, spec.satellite)) {
        return { status: 'failed', detail: `${spec.satellite} already exists; nothing was created` }
      }
      await runStatements(step.sql)
      const sat = await readTableFacts(schema, spec.satellite)
      if (!sat || !isOurSatellite(sat, spec)) {
        return { status: 'failed', detail: `the statements committed but ${spec.satellite} is not in the catalog as expected` }
      }
      const problems = [
        ...(!sat.rowSecurity || !sat.forceRowSecurity ? ['row-level security is not forced'] : []),
        ...(nonOwnerGrants(sat).length > 0
          ? [`grants exist for ${[...new Set(nonOwnerGrants(sat).map(g => g.grantee))].join(', ')}`]
          : []),
        ...spec.members.filter(m => !sat.columns.some(c => c.name === m)).map(m => `column ${m} is missing`),
      ]
      // Recorded on failure too: the table exists either way, and rollback's
      // stale guard needs its oid to know it may remove it.
      const observed = { kind: 'satellite', oid: sat.oid, columns: sat.columns.map(c => `${c.name}:${c.type}`) }
      if (problems.length > 0) {
        return { status: 'failed', detail: `${spec.satellite} was created but is not closed: ${problems.join('; ')}`, observed }
      }
      return {
        status: 'completed',
        detail: `${spec.satellite} created closed (oid ${sat.oid}, ${sat.columns.length} columns, row security forced, no grants)`,
        observed,
      }
    }

    case 'sync_forward': {
      const sat = await readTableFacts(schema, spec.satellite)
      if (!isOurSatellite(sat, spec)) return { status: 'failed', detail: `${spec.satellite} is not this ladder's table` }
      await runStatements(step.sql)
      const after = await readTableFacts(schema, spec.host)
      const trig = after?.triggers.find(t => t.name === n.forward)
      if (!trig) {
        return { status: 'failed', detail: `CREATE TRIGGER reported no error but ${n.forward} is not on ${spec.host}` }
      }
      return {
        status: 'completed',
        detail: `${n.forward} mirrors writes on ${spec.host} into ${spec.satellite}`,
        observed: { kind: 'trigger', table: spec.host, trigger: n.forward, sourceHash: sha(trig.functionSource) },
      }
    }

    case 'backfill': {
      // A dispatch that crashed after queueing and before the ledger recorded
      // it must not start a second chain beside the first.
      const running = await inFlightChain(projectId, plan.planVersion)
      if (running) {
        return { status: 'dispatched', detail: `backfill already running as job ${running}`, backgroundJobId: running }
      }
      const job = await enqueue(
        'evolution_backfill',
        {
          projectId,
          planId: plan.planId,
          planVersion: plan.planVersion,
          basisFingerprint: plan.basisFingerprint,
          spec,
          cursor: null,
        },
        { projectId },
      )
      return { status: 'dispatched', detail: `backfill queued as job ${job.id}`, backgroundJobId: job.id }
    }

    case 'verify': {
      const r = await reconcileExtraction(projectId, host, spec)
      return r.consistent
        ? { status: 'completed', detail: r.summary, evidence: { reconcile: r } }
        : { status: 'failed', detail: r.summary, evidence: { reconcile: r } }
    }

    case 'expose_reads': {
      const sat = await readTableFacts(schema, spec.satellite)
      if (!isOurSatellite(sat, spec)) return { status: 'failed', detail: `${spec.satellite} is not this ladder's table` }
      await runStatements(step.sql)
      const after = (await readTableFacts(schema, spec.satellite))!
      const missing = plan.access.readers.filter(
        r => !after.grants.some(g => g.grantee === r && g.privilege === 'SELECT'),
      )
      if (!after.policies.some(p => p.name === n.policies.select) || missing.length > 0) {
        return {
          status: 'failed',
          detail: `read access is not as planned: ${missing.length ? `SELECT missing for ${missing.join(', ')}` : 'the read policy is absent'}`,
        }
      }
      await registerTable(
        projectId,
        schema,
        spec.satellite,
        `The ${spec.label} concern of ${spec.host}, extracted by Backenly structural evolution`,
      )
      const reload = await reloadDataPlane()
      return {
        status: 'completed',
        detail: `${spec.satellite} readable by ${plan.access.readers.join(', ') || 'no role'} under ${spec.host}'s row rules; ${reload}`,
        evidence: { granted: plan.access.readers, reload },
        observed: { kind: 'reads', granted: plan.access.readers, policy: n.policies.select },
      }
    }

    case 'open_writes': {
      const sat = await readTableFacts(schema, spec.satellite)
      if (!isOurSatellite(sat, spec)) return { status: 'failed', detail: `${spec.satellite} is not this ladder's table` }
      await runStatements(step.sql)
      const after = (await readTableFacts(schema, spec.satellite))!
      const policies = [n.policies.insert, n.policies.update, n.policies.delete]
      const missingPolicies = policies.filter(p => !after.policies.some(x => x.name === p))
      const missingGrants = plan.access.writers.filter(
        r => !['INSERT', 'UPDATE', 'DELETE'].every(pr => after.grants.some(g => g.grantee === r && g.privilege === pr)),
      )
      if (!after.triggers.some(t => t.name === n.reverse) || missingPolicies.length || missingGrants.length) {
        return {
          status: 'failed',
          detail:
            `write access is not as planned: ` +
            [
              after.triggers.some(t => t.name === n.reverse) ? null : 'the reverse sync is absent',
              missingPolicies.length ? `policies missing: ${missingPolicies.join(', ')}` : null,
              missingGrants.length ? `grants missing for ${missingGrants.join(', ')}` : null,
            ].filter(Boolean).join('; '),
        }
      }
      const reload = await reloadDataPlane()
      return {
        status: 'completed',
        detail: `${spec.satellite} writable by ${plan.access.writers.join(', ') || 'no role'}; every write reaches ${spec.host}; ${reload}`,
        evidence: { granted: plan.access.writers, reload },
        observed: { kind: 'writes', granted: plan.access.writers, trigger: n.reverse },
      }
    }

    case 'contract':
      return { status: 'failed', detail: 'contract is performed by a person and is never run by the executor' }
  }
}
