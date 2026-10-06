/**
 * STRUCTURAL EVOLUTION AGAINST A REAL ENGINE — orders sheds its refunds
 * =====================================================================
 *
 * The canonical case end to end, in a real PostgreSQL, on a table built the way
 * the product builds them: row-level security forced, per-user policies, a
 * real non-superuser role, schema history in which refunds arrived two months
 * after the table did, and the request traffic of a live checkout.
 *
 *   detect      the refund columns are proposed; coupons+discounts, which
 *               arrived together but are set on different rows, are NOT;
 *               shipping, cohesive but costing nothing, is only watched
 *   rehearse    the whole ladder on a copy, every exercise reconciled, and
 *               afterwards no trace of it in the catalog
 *   consent     a stale version is refused; a moved table invalidates consent
 *   execute     mutations off: rehearses, then refuses at the first write;
 *               mutations on: creates, syncs, backfills, proves, opens
 *   behave      as a real role under RLS: old clients and new clients both
 *               work, see the same data, and can do exactly what they could
 *               do before — no more
 *   undo        refused while the satellite holds data its parent lacks;
 *               then lossless, leaving the host byte-for-byte as it was
 *
 * The local role is a SUPERUSER and PostgreSQL exempts superusers from RLS
 * entirely, so everything about access runs under `SET LOCAL ROLE` to a
 * NOSUPERUSER role created for this suite — the only way the policies are
 * actually consulted.
 */

import { randomUUID, randomBytes } from 'node:crypto'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { closeMaintenanceLockPool } from '@/lib/autonomy/maintenance/single-flight'
import { analyzeStructuralEvolution } from '@/lib/structural-evolution'
import { resolveExtractionPlan, isResolveRefusal } from '@/lib/structural-evolution/resolve'
import { rehearseExtraction } from '@/lib/structural-evolution/rehearse'
import { grantEvolutionApproval, isGrantRefusal, readLiveEvolutionApproval } from '@/lib/structural-evolution/consent'
import { executeExtraction } from '@/lib/structural-evolution/execute'
import { handleEvolutionBackfillJob } from '@/lib/structural-evolution/backfill-job'
import { reconcileExtraction } from '@/lib/structural-evolution/reconcile'
import { rollbackExtraction } from '@/lib/structural-evolution/rollback'
import { readTableFacts } from '@/lib/structural-evolution/facts'
import { ladderNames, type ExtractionSpec } from '@/lib/structural-evolution/sql'

jest.setTimeout(600_000)

const ROLE = `bkn_evo_it_${randomBytes(4).toString('hex')}`
const USER_A = randomUUID()
const USER_B = randomUUID()
const SPEC: ExtractionSpec = {
  host: 'orders',
  members: ['refund_amount', 'refund_reason', 'refunded_at'],
  satellite: 'order_refunds',
  label: 'refund',
}

let ownerId = ''
let projectId = ''
let schema = ''
let planId = ''
let planVersion = ''
const originalFlag = process.env.ENABLE_EVOLUTION_MUTATIONS

const q = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p)
const rows = <T = any>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p)
const t = (name: string) => `"${schema}"."${name}"`

/** Read as the platform (service claim), which every workspace table requires. */
async function asService<T = any>(sql: string, ...p: unknown[]): Promise<T[]> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }))
    return tx.$queryRawUnsafe<T[]>(sql, ...p)
  })
}

/** Run as an end user: a NOSUPERUSER role with the `authenticated` claim, so RLS is real. */
async function asUser<T>(sub: string, fn: (run: (sql: string, ...p: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${ROLE}"`)
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: sub }))
    return fn((sql, ...p) => tx.$queryRawUnsafe<any[]>(sql, ...p))
  })
}

async function asUserFails(sub: string, sql: string, ...p: unknown[]): Promise<string> {
  try {
    await asUser(sub, run => run(sql, ...p))
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return ''
}

async function drainBackfill(): Promise<number> {
  let ran = 0
  for (let i = 0; i < 50; i++) {
    const job = await prisma.backgroundJob.findFirst({
      where: { projectId, type: 'evolution_backfill', status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    if (!job) break
    const result = await handleEvolutionBackfillJob(job.payload as any)
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: 'completed', result: result as object, completedAt: new Date() },
    })
    ran++
  }
  return ran
}

/** A bare (no refund) order owned by `sub`. */
async function bareOrder(sub: string, offset = 0): Promise<string> {
  const r = await asService<{ id: string }>(
    `SELECT id::text AS id FROM ${t('orders')} WHERE user_id = $1::uuid AND status = 'placed'
       AND refund_amount IS NULL AND refund_reason IS NULL AND refunded_at IS NULL ORDER BY id OFFSET $2 LIMIT 1`,
    sub,
    offset,
  )
  return r[0].id
}

const hostSnapshot = () =>
  asService<{ id: string; v: string }>(
    `SELECT id::text AS id, ROW(refund_amount, refund_reason, refunded_at, coupon_code, total, status)::text AS v
       FROM ${t('orders')} ORDER BY id`,
  )

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `evo-${randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'evo' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'evolution-it', userId: ownerId } })).id
  schema = await resolveWorkspaceSchema(projectId)

  await q(`CREATE SCHEMA "${schema}"`)
  await q(jwtClaimFunctionSql(schema))
  await q(`CREATE TABLE ${t('orders')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    total numeric NOT NULL,
    status text NOT NULL DEFAULT 'placed',
    created_at timestamptz NOT NULL DEFAULT now(),
    shipping_address text,
    shipping_method text,
    refund_amount numeric CHECK (refund_amount >= 0),
    refund_reason text,
    refunded_at timestamptz,
    coupon_code text,
    discount_amount numeric
  )`)
  await q(`CREATE INDEX orders_refunded_at_idx ON ${t('orders')} (refunded_at)`)
  // 300 orders. Refunds on every fifth, set together and two days after the
  // order; coupons and discounts on DIFFERENT rows; shipping on every third.
  await q(
    `INSERT INTO ${t('orders')} (user_id, total, status, created_at, shipping_address, shipping_method,
                                 refund_amount, refund_reason, refunded_at, coupon_code, discount_amount)
     SELECT CASE WHEN i % 2 = 0 THEN $1::uuid ELSE $2::uuid END,
            (i % 90) + 10,
            CASE WHEN i % 10 = 3 THEN 'public' ELSE 'placed' END,
            now() - (i || ' hours')::interval,
            CASE WHEN i % 3 = 0 THEN 'street ' || i END,
            CASE WHEN i % 3 = 0 THEN 'courier' END,
            CASE WHEN i % 5 = 0 THEN (i % 40) + 1 END,
            CASE WHEN i % 5 = 0 THEN 'damaged' END,
            CASE WHEN i % 5 = 0 THEN now() - (i || ' hours')::interval + interval '2 days' END,
            CASE WHEN i % 5 = 1 THEN 'SAVE10' END,
            CASE WHEN i % 5 = 2 THEN 5 END
       FROM generate_series(1, 300) i`,
    USER_A,
    USER_B,
  )

  const svc = `"${schema}"."backenly_jwt_claim"('role') = 'service_role'`
  const sub = `"${schema}"."backenly_jwt_claim"('sub')`
  await q(`ALTER TABLE ${t('orders')} ENABLE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE ${t('orders')} FORCE ROW LEVEL SECURITY`)
  // Own rows, plus public orders readable (not writable) by anyone signed in —
  // the shape that lets a test tell "may see" apart from "may change".
  await q(`CREATE POLICY orders_select ON ${t('orders')} FOR SELECT USING (${svc} OR user_id::text = ${sub} OR status = 'public')`)
  await q(`CREATE POLICY orders_insert ON ${t('orders')} FOR INSERT WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await q(`CREATE POLICY orders_update ON ${t('orders')} FOR UPDATE USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await q(`CREATE POLICY orders_delete ON ${t('orders')} FOR DELETE USING (${svc} OR user_id::text = ${sub})`)
  await q(`CREATE ROLE "${ROLE}" NOLOGIN NOSUPERUSER`)
  await q(`GRANT USAGE ON SCHEMA "${schema}" TO "${ROLE}"`)
  await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t('orders')} TO "${ROLE}"`)
  await q(`ANALYZE ${t('orders')}`)

  // Schema history: the table 200 days ago, refunds 60 days ago, coupons 20.
  const base = ['id', 'user_id', 'total', 'status', 'created_at', 'shipping_address', 'shipping_method']
  // Version 1 predates the table, so the table's own birth is inside history.
  const snap = (v: number, days: number, cols: string[] | null) =>
    prisma.workspaceSchemaSnapshot.create({
      data: {
        projectId,
        versionNum: v,
        trigger: 'post_migration',
        rawDdl: '',
        createdAt: new Date(Date.now() - days * 86_400_000),
        tables: cols
          ? [{ name: 'orders', columns: cols.map(name => ({ name, type: 'text', nullable: true, default: null, isPrimary: name === 'id' })) }]
          : [],
      },
    })
  await snap(1, 220, null)
  await snap(2, 200, base)
  await snap(3, 60, [...base, 'refund_amount', 'refund_reason', 'refunded_at'])
  await snap(4, 20, [...base, 'refund_amount', 'refund_reason', 'refunded_at', 'coupon_code', 'discount_amount'])

  // A live checkout: 1,200 requests to orders in the last day.
  await prisma.apiRequestLog.createMany({
    data: Array.from({ length: 1_200 }, () => ({
      projectId,
      userId: ownerId,
      method: 'GET',
      path: '/db/orders',
      statusCode: 200,
      duration: 4,
      timestamp: new Date(Date.now() - 86_400_000),
    })),
  })

  // A function Backenly wrote that reads a refund column.
  await prisma.aiFunction.create({
    data: {
      projectId,
      name: 'refund-mailer',
      description: 'email the customer when a refund is issued',
      generatedCode: 'export default async ({ row }) => sendMail(row.user_id, `Refunded ${row.refund_amount}`)',
      triggerType: 'on_db_update',
      triggerTable: 'orders',
    },
  })
}, 120_000)

afterAll(async () => {
  if (originalFlag === undefined) delete process.env.ENABLE_EVOLUTION_MUTATIONS
  else process.env.ENABLE_EVOLUTION_MUTATIONS = originalFlag
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await q(`DROP OWNED BY "${ROLE}"`).catch(() => {})
  await q(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => {})
  await prisma.maintenanceStepExecution.deleteMany({ where: { execution: { projectId } } }).catch(() => {})
  await prisma.maintenanceExecution.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.backgroundJob.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeMaintenanceLockPool()
}, 60_000)

// ── Detect ───────────────────────────────────────────────────────────────────

describe('detection', () => {
  it('proposes the refund concern, on evidence it measured', async () => {
    const report = await analyzeStructuralEvolution(projectId)
    const refunds = report.proposals.find(p => p.members.includes('refund_amount'))!
    expect(refunds).toBeDefined()
    expect(refunds.members).toEqual(SPEC.members)
    expect(refunds.fires).toBe(true)
    expect(refunds.state).toBe('proposed')
    expect(refunds.spec.satellite).toBe('order_refunds')
    const v = Object.fromEntries(refunds.families.map(f => [f.family, f.verdict]))
    expect(v).toMatchObject({ lexical: 'supports', co_presence: 'supports', cohort: 'supports', lifecycle: 'supports' })
    expect(refunds.pressure.map(p => p.kind)).toContain('hot_host_change')
    expect(refunds.presenceRate).toBeCloseTo(0.2, 1)
    expect(refunds.plan.validity).toBe('executable')
    expect(refunds.plan.contractBlockers.join('\n')).toMatch(/refund-mailer/)
    expect(refunds.clientMigration[0].after).toBe('GET /db/orders?select=id,order_refunds(refund_amount,refund_reason,refunded_at)')
    planId = refunds.planId
    planVersion = refunds.plan.planVersion
  })

  it('does not propose coupons with discounts, and only watches shipping', async () => {
    const report = await analyzeStructuralEvolution(projectId)
    expect(report.proposals.some(p => p.members.includes('coupon_code') || p.members.includes('discount_amount'))).toBe(false)
    expect(report.proposals.some(p => p.members.includes('shipping_address'))).toBe(false)
    const shipping = report.watching.find(w => w.members.includes('shipping_address'))!
    expect(shipping.members).toEqual(['shipping_address', 'shipping_method'])
    expect(shipping.verdict).toMatch(/^Watching/)
  })
})

// ── Rehearse ─────────────────────────────────────────────────────────────────

describe('rehearsal', () => {
  it('runs the ladder on a copy, every exercise reconciles, and nothing remains', async () => {
    const resolved = await resolveExtractionPlan(projectId, SPEC)
    if (isResolveRefusal(resolved)) throw new Error(resolved.refusal)
    const r = await rehearseExtraction(resolved.facts, SPEC, planId)
    expect(r.error).toBeNull()
    expect(r.exercises.filter(e => e.outcome === 'failed')).toEqual([])
    expect(r.exercises.filter(e => e.outcome === 'passed').map(e => e.name)).toEqual([
      'backfill',
      'insert_with_concern',
      'update_concern',
      'clear_concern',
      'set_concern_on_bare_row',
      'update_through_satellite',
      'delete_through_satellite',
      'insert_through_satellite',
      'parent_key_is_immutable',
      'delete_parent',
    ])
    expect(r.passed).toBe(true)
    expect(r.sampledRows).toBe(260) // 60 with refunds + 200 without (capped)
    // Access was rehearsed, identity by identity, not only data.
    expect(r.authorization.status).toBe('passed')
    expect(r.authorization.identities).toBeGreaterThanOrEqual(3)
    expect(r.authorization.checks.filter(c => c.outcome === 'failed')).toEqual([])
    expect(r.notRehearsed.join('\n')).not.toMatch(/who may read and write/)

    const scratch = await rows(`SELECT 1 FROM pg_namespace WHERE nspname LIKE 'bkn_rehearsal_%'`)
    expect(scratch).toEqual([])
    expect(await readTableFacts(schema, 'order_refunds')).toBeNull()
    expect((await readTableFacts(schema, 'orders'))!.triggers).toEqual([])
  })
})

// ── Consent ──────────────────────────────────────────────────────────────────

describe('consent', () => {
  it('refuses a version nobody was shown', async () => {
    const r = await grantEvolutionApproval({
      projectId, spec: SPEC, planVersion: 'not-a-version', approvedBy: ownerId, resolve: resolveExtractionPlan,
    })
    expect(isGrantRefusal(r) && r.currentPlanVersion).toBe(planVersion)
  })

  it('records consent for the version that was shown', async () => {
    const r = await grantEvolutionApproval({
      projectId, spec: SPEC, planVersion, approvedBy: ownerId, reason: 'refunds outgrew orders', resolve: resolveExtractionPlan,
    })
    expect(r.ok).toBe(true)
    expect((await readLiveEvolutionApproval(projectId, planId))!.planVersion).toBe(planVersion)
  })

  it('stops honouring it the moment somebody else changes the table', async () => {
    await q(`ALTER TABLE ${t('orders')} ADD CONSTRAINT orders_total_positive CHECK (total > 0)`)
    const out = await executeExtraction({ projectId, planId })
    expect(out.status).toBe('refused')
    expect(out.haltReason).toMatch(/re-approved/)
    expect(await readTableFacts(schema, 'order_refunds')).toBeNull()
    await q(`ALTER TABLE ${t('orders')} DROP CONSTRAINT orders_total_positive`)
  })
})

// ── Execute ──────────────────────────────────────────────────────────────────

describe('the governed executor', () => {
  it('with mutations off, rehearses and then refuses at the first rung that would write', async () => {
    delete process.env.ENABLE_EVOLUTION_MUTATIONS
    const out = await executeExtraction({ projectId, planId })
    expect(out.status).toBe('halted')
    expect(out.steps.map(s => [s.kind, s.status])).toEqual([['rehearse', 'completed']])
    expect(out.haltReason).toMatch(/mutations are disabled/)
    expect(await readTableFacts(schema, 'order_refunds')).toBeNull()
  })

  it('with mutations on, builds the satellite closed, syncs it and hands the backfill to the queue', async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    const out = await executeExtraction({ projectId, planId })
    expect(out.status).toBe('awaiting_background_work')
    expect(out.steps.map(s => [s.kind, s.status])).toEqual([
      ['rehearse', 'skipped'],
      ['create_satellite', 'completed'],
      ['sync_forward', 'completed'],
      ['backfill', 'dispatched'],
    ])
    const sat = (await readTableFacts(schema, 'order_refunds'))!
    expect(sat.forceRowSecurity).toBe(true)
    expect(sat.grants.filter(g => g.grantee !== sat.owner)).toEqual([])
    // The host's CHECK and its index on a member came along.
    expect(sat.constraints.some(c => c.kind === 'c' && /refund_amount >= /.test(c.definition))).toBe(true)
    expect(sat.indexes.some(i => /\(refunded_at\)/.test(i.definition))).toBe(true)
  })

  it('resumes after the backfill and finishes everything software may do', async () => {
    expect(await drainBackfill()).toBeGreaterThanOrEqual(1)
    const out = await executeExtraction({ projectId, planId })
    expect(out.status).toBe('completed')
    expect(out.steps.map(s => [s.kind, s.status])).toEqual([
      ['rehearse', 'skipped'],
      ['create_satellite', 'skipped'],
      ['sync_forward', 'skipped'],
      ['backfill', 'completed'],
      ['verify', 'completed'],
      ['expose_reads', 'completed'],
      ['open_writes', 'completed'],
      ['verify', 'completed'],
      ['contract', 'awaiting_human'],
    ])
    const sat = (await readTableFacts(schema, 'order_refunds'))!
    const mine = sat.grants.filter(g => g.grantee === ROLE).map(g => g.privilege).sort()
    expect(mine).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
    const r = await reconcileExtraction(projectId, (await readTableFacts(schema, 'orders'))!, SPEC)
    expect(r).toMatchObject({ consistent: true, present: 60, satelliteRows: 60 })
  })
})

// ── Behave ───────────────────────────────────────────────────────────────────

describe('after the extraction, as a real role under row-level security', () => {
  const fk = ladderNames(SPEC).fkColumn

  it('sees exactly the refunds of the orders it can see', async () => {
    const [host, sat] = await asUser(USER_A, async run => [
      Number((await run(`SELECT count(*)::int AS n FROM ${t('orders')} WHERE refund_amount IS NOT NULL`))[0].n),
      Number((await run(`SELECT count(*)::int AS n FROM ${t('order_refunds')}`))[0].n),
    ])
    expect(host).toBeGreaterThan(0)
    expect(host).toBeLessThan(60)
    expect(sat).toBe(host)
  })

  it('old clients keep writing the old columns, and new clients see it', async () => {
    const id = await bareOrder(USER_A)
    await asUser(USER_A, run =>
      run(`UPDATE ${t('orders')} SET refund_amount = 7, refund_reason = 'late', refunded_at = now() WHERE id = $1::uuid`, id),
    )
    const sat = await asUser(USER_A, run => run(`SELECT refund_amount::text AS a, refund_reason AS r FROM ${t('order_refunds')} WHERE ${fk} = $1::uuid`, id))
    expect(sat).toEqual([{ a: '7', r: 'late' }])

    await asUser(USER_A, run => run(`UPDATE ${t('orders')} SET refund_amount = NULL, refund_reason = NULL, refunded_at = NULL WHERE id = $1::uuid`, id))
    expect(await asService(`SELECT 1 FROM ${t('order_refunds')} WHERE ${fk} = $1::uuid`, id)).toEqual([])
  })

  it('new clients write the new table, and old clients see it', async () => {
    const id = await bareOrder(USER_A, 1)
    await asUser(USER_A, run => run(`INSERT INTO ${t('order_refunds')} (${fk}, refund_amount, refund_reason) VALUES ($1::uuid, 12, 'new path')`, id))
    expect(await asService(`SELECT refund_amount::text AS a, refund_reason AS r FROM ${t('orders')} WHERE id = $1::uuid`, id)).toEqual([
      { a: '12', r: 'new path' },
    ])
    await asUser(USER_A, run => run(`UPDATE ${t('order_refunds')} SET refund_reason = 'edited' WHERE ${fk} = $1::uuid`, id))
    expect((await asService(`SELECT refund_reason AS r FROM ${t('orders')} WHERE id = $1::uuid`, id))[0].r).toBe('edited')
    await asUser(USER_A, run => run(`DELETE FROM ${t('order_refunds')} WHERE ${fk} = $1::uuid`, id))
    expect(await asService(`SELECT refund_amount, refund_reason FROM ${t('orders')} WHERE id = $1::uuid`, id)).toEqual([
      { refund_amount: null, refund_reason: null },
    ])
  })

  it('cannot reach an order it cannot see through the new table', async () => {
    const theirs = await bareOrder(USER_B)
    const err = await asUserFails(USER_A, `INSERT INTO ${t('order_refunds')} (${fk}, refund_amount) VALUES ($1::uuid, 1)`, theirs)
    expect(err).toMatch(/row-level security/)
  })

  it('cannot change an order it may see but not update — the parent\'s update policy still decides', async () => {
    const pub = await asService<{ id: string }>(
      `SELECT id::text AS id FROM ${t('orders')} WHERE user_id = $1::uuid AND status = 'public' AND refund_amount IS NULL LIMIT 1`,
      USER_B,
    )
    const visible = await asUser(USER_A, run => run(`SELECT 1 FROM ${t('orders')} WHERE id = $1::uuid`, pub[0].id))
    expect(visible.length).toBe(1)
    const err = await asUserFails(USER_A, `INSERT INTO ${t('order_refunds')} (${fk}, refund_amount) VALUES ($1::uuid, 1)`, pub[0].id)
    expect(err).toMatch(/permission denied: this change to order_refunds changes orders row/)
    expect((await asService(`SELECT refund_amount FROM ${t('orders')} WHERE id = $1::uuid`, pub[0].id))[0].refund_amount).toBeNull()
  })

  it('refuses to move a refund to another order', async () => {
    const [mine] = await asUser(USER_A, run => run(`SELECT ${fk}::text AS k FROM ${t('order_refunds')} LIMIT 1`))
    const other = await bareOrder(USER_A, 2)
    const err = await asUserFails(USER_A, `UPDATE ${t('order_refunds')} SET ${fk} = $1::uuid WHERE ${fk} = $2::uuid`, other, mine.k)
    expect(err).toMatch(/cannot change while orders still carries these columns/)
  })

  it('follows a deleted order, and is still identical to it afterwards', async () => {
    const [mine] = await asUser(USER_A, run =>
      run(`SELECT o.id::text AS id FROM ${t('orders')} o JOIN ${t('order_refunds')} r ON r.${fk} = o.id WHERE o.user_id = $1::uuid LIMIT 1`, USER_A),
    )
    await asUser(USER_A, run => run(`DELETE FROM ${t('orders')} WHERE id = $1::uuid`, mine.id))
    expect(await asService(`SELECT 1 FROM ${t('order_refunds')} WHERE ${fk} = $1::uuid`, mine.id)).toEqual([])
    const r = await reconcileExtraction(projectId, (await readTableFacts(schema, 'orders'))!, SPEC)
    expect(r.consistent).toBe(true)
  })

  it('reports the extraction as done, and never analyses the new table as a host', async () => {
    const report = await analyzeStructuralEvolution(projectId)
    expect(report.proposals.find(p => p.planId === planId)!.state).toBe('extracted')
    expect(report.tables.map(x => x.table)).not.toContain('order_refunds')
  })
})

// ── Undo ─────────────────────────────────────────────────────────────────────

describe('rollback', () => {
  it('refuses while the new table holds data its parent does not', async () => {
    const id = await bareOrder(USER_B, 3)
    const fk = ladderNames(SPEC).fkColumn
    // Written around both syncs, the way a tool that disables triggers would.
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`INSERT INTO ${t('order_refunds')} (${fk}, refund_amount) VALUES ($1::uuid, 3)`, id)
    })
    const out = await rollbackExtraction({ projectId, planId, requestedBy: ownerId })
    expect(out.status).toBe('refused')
    expect(out.reason).toMatch(/holds data orders does not \(1 orphaned/)
    expect(await readTableFacts(schema, 'order_refunds')).not.toBeNull()
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`DELETE FROM ${t('order_refunds')} WHERE ${fk} = $1::uuid`, id)
    })
  })

  it('removes everything it added and leaves the host exactly as it was', async () => {
    const before = await hostSnapshot()
    const out = await rollbackExtraction({ projectId, planId, requestedBy: ownerId })
    expect(out.status).toBe('rolled_back')
    expect(out.actions.map(a => [a.action, a.outcome])).toEqual([
      ['close_writes', 'done'],
      ['revoke_reads', 'done'],
      ['drop_forward_sync', 'done'],
      ['drop_satellite', 'done'],
      ['withdraw_consent', 'done'],
    ])
    expect(await readTableFacts(schema, 'order_refunds')).toBeNull()
    expect((await readTableFacts(schema, 'orders'))!.triggers).toEqual([])
    expect(await hostSnapshot()).toEqual(before)
    expect(await readLiveEvolutionApproval(projectId, planId)).toBeNull()

    const report = await analyzeStructuralEvolution(projectId)
    expect(report.proposals.find(p => p.planId === planId)!.state).toBe('rolled_back')
  })

  it('has nothing left to undo the second time', async () => {
    const out = await rollbackExtraction({ projectId, planId, requestedBy: ownerId })
    expect(out.status).toBe('nothing_to_undo')
  })
})
