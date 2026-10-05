/**
 * RECONCILE — the only thing allowed to say the two representations agree
 * =======================================================================
 *
 * The forward sync swallows its own errors so a customer's write can never fail
 * because of it. That makes it untrustworthy as a witness: a trigger that
 * failed and a trigger that worked both report nothing. The maintenance ladder
 * learned this first and built reconciliation before anything that mutates;
 * this is the same rule for a table split.
 *
 * Three ways to disagree, each counted and sampled:
 *
 *   missing     the host carries the concern, the satellite has no row
 *   orphaned    the satellite has a row, the host does not carry the concern
 *   mismatched  both have it, the values differ
 *
 * Read at ONE snapshot (REPEATABLE READ) and as the platform. Two snapshots
 * would report a write landing between them as a mismatch that never existed;
 * reading as nobody would see two empty tables under forced row security and
 * call them identical.
 *
 * Read-only.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { readDualWriteFaults, type DualWriteFaults } from '@/lib/autonomy/maintenance/primitives/dual-write'
import type { TableFacts } from './facts'
import { ladderNames, reconcileSql, type ExtractionSpec, type RenderTarget } from './sql'

export interface ReconcileResult {
  consistent: boolean
  present: number
  satelliteRows: number
  missing: number
  orphaned: number
  mismatched: number
  samples: { missing: string[]; orphaned: string[]; mismatched: string[] }
  /** What the forward sync admitted to. Telemetry, never the verdict. */
  faults: DualWriteFaults | null
  summary: string
}

type Tx = Prisma.TransactionClient

export async function reconcileWith(
  tx: Tx,
  facts: TableFacts,
  spec: ExtractionSpec,
  target: RenderTarget,
): Promise<Omit<ReconcileResult, 'faults'>> {
  const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(reconcileSql(facts, spec, target))
  const r = rows[0] ?? {}
  const n = (k: string) => Number(r[k] ?? 0)
  const keys = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).map(String) : [])
  const result = {
    present: n('present'),
    satelliteRows: n('satellite_rows'),
    missing: n('missing'),
    orphaned: n('orphaned'),
    mismatched: n('mismatched'),
    samples: { missing: keys('missing_keys'), orphaned: keys('orphaned_keys'), mismatched: keys('mismatched_keys') },
  }
  const consistent = result.missing === 0 && result.orphaned === 0 && result.mismatched === 0
  return {
    ...result,
    consistent,
    summary: consistent
      ? `${result.satelliteRows} row(s) in ${spec.satellite} match the ${result.present} ${spec.host} row(s) carrying ${spec.label} data`
      : `${spec.satellite} disagrees with ${spec.host}: ${result.missing} missing, ${result.orphaned} orphaned, ` +
        `${result.mismatched} with different values`,
  }
}

/** Reconcile the live tables. */
export async function reconcileExtraction(
  projectId: string,
  facts: TableFacts,
  spec: ExtractionSpec,
): Promise<ReconcileResult> {
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  const result = await prisma.$transaction(
    async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '120s'`)
      await tx.$executeRawUnsafe(
        rlsSessionSql(1),
        ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }),
      )
      return reconcileWith(tx, facts, spec, { schema: facts.schema })
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 130_000, maxWait: 10_000 },
  )
  const faults = await readDualWriteFaults(projectId, ladderNames(spec).forward).catch(() => null)
  return { ...result, faults }
}
