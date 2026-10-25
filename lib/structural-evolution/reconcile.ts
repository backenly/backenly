/**
 * RECONCILE — the only thing allowed to say the two representations agree
 * =======================================================================
 *
 * Both syncs are fail-closed (see ./sql.ts), so through any supported path a
 * committed transaction leaves the two representations equal. Reconciliation
 * is what checks that instead of believing it: a write that bypassed triggers
 * (replica mode, a disabled trigger, a restore) leaves no other trace. Nothing
 * is opened to clients, observed as stable or rolled back without it.
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
 * And only from a COMPLETE view. The platform role is subject to the host's
 * own row-level security; rows the host hides from it would simply be absent
 * from both counts, and two partial views agree perfectly. So before anything
 * is compared, `hostVisibility` establishes from the catalog that this
 * transaction sees every host row: through Backenly's own read policy, inside
 * the ladder's context, with no RESTRICTIVE policy binding its role. When that
 * cannot be established the answer is "not consistent", with the reason —
 * never a comparison of the part it could see.
 *
 * Read-only.
 */

import { Prisma } from '@prisma/client'
import type { TableFacts } from './facts'
import { workspaceAt } from './workspace'
import { fq, ladderAccessSql, ladderNames, reconcileSql, type ExtractionSpec, type RenderTarget } from './sql'

export interface ReconcileResult {
  consistent: boolean
  /** Whether every host row was visible. False means nothing was compared; `consistent` is then false too. */
  complete: boolean
  present: number
  satelliteRows: number
  missing: number
  orphaned: number
  mismatched: number
  samples: { missing: string[]; orphaned: string[]; mismatched: string[] }
  summary: string
}

type Tx = Prisma.TransactionClient

export interface HostVisibility {
  complete: boolean
  /** Why not, in words a person can act on. */
  reason: string | null
}

/**
 * Can this transaction see every row of the host? Decided from the catalog,
 * never by counting what it happens to see:
 *
 *   yes  a superuser or BYPASSRLS role; row security off on the host; the owner
 *        of a host that does not FORCE row security; or the ladder's own read
 *        policy (TO this role, the ladder's context as its only test) in place,
 *        this transaction in that context, and no RESTRICTIVE policy for reads
 *        or row locks binding this role (permissive policies are OR-ed, so
 *        Backenly's adds rows; restrictive ones are AND-ed, and nothing can)
 *   no   anything else, with the reason
 */
export async function hostVisibility(tx: Tx, spec: ExtractionSpec, target: RenderTarget): Promise<HostVisibility> {
  const n = ladderNames(spec)
  const host = fq(target.schema, spec.host)
  const [v] = await tx.$queryRawUnsafe<
    Array<{ bypass: boolean; rls: boolean; force: boolean; owner: boolean; ladder: boolean; restrictive: string[]; own_policy: boolean }>
  >(
    `SELECT (r.rolsuper OR r.rolbypassrls) AS bypass,
            c.relrowsecurity AS rls, c.relforcerowsecurity AS force, c.relowner = r.oid AS owner,
            COALESCE(current_setting($2, true), '') = 'on' AS ladder,
            ARRAY(SELECT p.polname::text FROM pg_policy p
                   WHERE p.polrelid = c.oid AND NOT p.polpermissive AND p.polcmd IN ('r', 'w', '*')
                     AND (0 = ANY (p.polroles) OR EXISTS (SELECT 1 FROM unnest(p.polroles) pr WHERE pr <> 0 AND pg_has_role(r.oid, pr, 'USAGE')))
                   ORDER BY 1) AS restrictive,
            EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid = c.oid AND p.polname = $3 AND p.polpermissive AND p.polcmd = 'r'
                       AND p.polroles = ARRAY[r.oid]::oid[]
                       AND pg_get_expr(p.polqual, p.polrelid) LIKE '%' || quote_literal($2) || '%'
                       AND pg_get_expr(p.polqual, p.polrelid) NOT ILIKE '% OR %') AS own_policy
       FROM pg_roles r, pg_class c
      WHERE r.rolname = current_user AND c.oid = $1::regclass`,
    host,
    n.access,
    n.policies.hostRead,
  )
  if (!v) return { complete: false, reason: `${spec.host} could not be found` }
  if (v.bypass || !v.rls || (v.owner && !v.force)) return { complete: true, reason: null }
  if (v.restrictive.length > 0) {
    return {
      complete: false,
      reason: `a restrictive row-level policy on ${spec.host} (${v.restrictive.join(', ')}) also binds Backenly's own database role, so some rows are hidden from it`,
    }
  }
  if (!v.own_policy) return { complete: false, reason: `Backenly's own read policy on ${spec.host} is not in place` }
  if (!v.ladder) return { complete: false, reason: 'this read did not run in the ladder\'s own context' }
  return { complete: true, reason: null }
}

export async function reconcileWith(
  tx: Tx,
  facts: TableFacts,
  spec: ExtractionSpec,
  target: RenderTarget,
): Promise<ReconcileResult> {
  const visibility = await hostVisibility(tx, spec, target)
  if (!visibility.complete) {
    return {
      consistent: false,
      complete: false,
      present: 0,
      satelliteRows: 0,
      missing: 0,
      orphaned: 0,
      mismatched: 0,
      samples: { missing: [], orphaned: [], mismatched: [] },
      summary:
        `Backenly cannot see every row of ${spec.host}: ${visibility.reason}. ` +
        `It does not call ${spec.satellite} consistent from part of the data`,
    }
  }
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
    complete: true,
    summary: consistent
      ? `${result.satelliteRows} row(s) in ${spec.satellite} match the ${result.present} ${spec.host} row(s) carrying ${spec.label} data`
      : `${spec.satellite} disagrees with ${spec.host}: ${result.missing} missing, ${result.orphaned} orphaned, ` +
        `${result.mismatched} with different values`,
  }
}

/**
 * Reconcile the live tables. The sample keys are rows' own values: for a
 * project kept in another region they stay there, and the result carries the
 * counts alone (./residency.ts).
 */
export async function reconcileExtraction(
  projectId: string,
  facts: TableFacts,
  spec: ExtractionSpec,
): Promise<ReconcileResult> {
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  // On the project's own database, where facts were read: both tables, one snapshot.
  const { db, quote } = await workspaceAt(projectId)
  const r = await db.$transaction(
    async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '120s'`)
      await tx.$executeRawUnsafe(
        rlsSessionSql(1),
        ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }),
      )
      // Every satellite row, not only those a client could see.
      await tx.$executeRawUnsafe(ladderAccessSql(spec))
      return reconcileWith(tx, facts, spec, { schema: facts.schema })
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 130_000, maxWait: 10_000 },
  )
  return quote ? r : { ...r, samples: { missing: [], orphaned: [], mismatched: [] } }
}
