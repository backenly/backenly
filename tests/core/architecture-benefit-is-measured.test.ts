/**
 * WHAT AN EXTRACTION IS WATCHED AND JUDGED BY — against a real engine
 * ===================================================================
 *
 * orders sheds its refunds, for real (rehearse → create → sync → backfill →
 * verify → expose → open → verify), and then the telemetry that watches it is
 * held to what it claims:
 *
 *   observe   the two shapes agree and the satellite is the one Backenly built;
 *             a row deleted behind the triggers' back is seen; a renamed-away
 *             satellite is seen; server errors on the new table are counted on
 *             BOTH request surfaces, /db/<table> (v1) and /<table> (v2)
 *   snapshot  table counters, statement classes, the 7-day request aggregate at
 *             S0 and the concern evidence, small enough for an audit row; text
 *             hidden from a non-privileged role is reported, never summed
 *   measure   guardrails from equal request windows (preview branches and
 *             platform rows excluded), the statement-time guardrail, the costs,
 *             and the two pressure-linked benefits — and every number that
 *             cannot be had carries a reason instead of a zero
 *
 * Time is virtual where it can be: snapshots and measurements take `now` as an
 * argument, so the phases R, S0, S1, S2 are placed hours apart and the request
 * log, schema history and health findings are written at matching times. The
 * counters and statement statistics are real and are read when each snapshot
 * is taken, in the order a real change would take them.
 *
 * The local role is a SUPERUSER, which PostgreSQL exempts from row-level
 * security and lets read every statement's text; client work is therefore run
 * under `SET LOCAL ROLE` to a NOSUPERUSER role, which is also what makes it
 * client work rather than Backenly's own in pg_stat_statements.
 *
 * Statement statistics need pg_stat_statements preloaded, which a server must
 * be restarted for. Where it is (docker-compose.dev.yml, CI's autonomy job),
 * the statement-time measurement is held to its numbers; where it is not, to
 * saying so: `extension_missing`, never a zero. Neither case skips a test.
 */

import { randomUUID, randomBytes } from 'node:crypto'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { closeMaintenanceLockPool } from '@/lib/autonomy/maintenance/single-flight'
import { resolveExtractionPlan, isResolveRefusal } from '@/lib/structural-evolution/resolve'
import { grantEvolutionApproval } from '@/lib/structural-evolution/consent'
import { executeExtraction } from '@/lib/structural-evolution/execute'
import { handleEvolutionBackfillJob } from '@/lib/structural-evolution/backfill-job'
import { ladderNames, type ExtractionSpec } from '@/lib/structural-evolution/sql'
import type { ExtractionPlan } from '@/lib/structural-evolution/plan'
import {
  measureExtraction,
  observeExtraction,
  readStatementClasses,
  snapshotExtraction,
  type ExtractionTelemetry,
} from '@/lib/structural-evolution/telemetry'
import { assessBenefit } from '@/lib/evolution-engine/benefit'
import { CONSISTENCY_SIGNAL } from '@/lib/evolution-engine/observe'
import type { Measurement, TelemetrySnapshot } from '@/lib/evolution-engine/primitive'

jest.setTimeout(600_000)

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T = Date.now()
const ago = (ms: number) => new Date(T - ms)

const ROLE = `bkn_evo_tm_${randomBytes(4).toString('hex')}`
const USER_A = randomUUID()
const USER_B = randomUUID()
const SPEC: ExtractionSpec = {
  host: 'orders',
  members: ['refund_amount', 'refund_reason', 'refunded_at'],
  satellite: 'order_refunds',
  label: 'refund',
}
const PASS = { correctness: 'pass', compatibility: 'pass', authorization: 'pass' } as const

// The phases, hours apart. L at the first measurement is S2 − S1 = 8h.
const AT = { R: ago(20 * HOUR), S0: ago(19 * HOUR), S1: ago(10 * HOUR), S2: ago(2 * HOUR) }

let ownerId = ''
let projectId = ''
let schema = ''
let plan: ExtractionPlan
/** Whether pg_stat_statements is installed and readable here; see the header. */
let PGSS = false
const snap: Partial<Record<'R' | 'S0' | 'S1' | 'S2', TelemetrySnapshot>> = {}
const originalFlag = process.env.ENABLE_EVOLUTION_MUTATIONS

const q = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p)
const t = (name: string) => `"${schema}"."${name}"`
const data = (s: TelemetrySnapshot) => s.data as unknown as ExtractionTelemetry
const byName = (ms: Measurement[], name: string) => ms.find(m => m.name === name)!
const clone = (s: TelemetrySnapshot, edit: (d: ExtractionTelemetry, s: TelemetrySnapshot) => void): TelemetrySnapshot => {
  const c = JSON.parse(JSON.stringify(s)) as TelemetrySnapshot
  edit(data(c), c)
  return c
}
/** The same snapshot as if pg_stat_statements had dropped nothing since the run began. */
const steady = (s: TelemetrySnapshot) => clone(s, d => { d.pgss.dealloc = 0 })

async function asService<T = any>(sql: string, ...p: unknown[]): Promise<T[]> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }))
    return tx.$queryRawUnsafe<T[]>(sql, ...p)
  })
}

/**
 * Client writes: `n` updates of a refund column on USER_A's refunded orders,
 * each its own transaction, as the NOSUPERUSER role under RLS. The backend's
 * pending table statistics are flushed when it goes idle.
 */
async function clientWrites(n: number, reason: string): Promise<void> {
  const ids = (
    await asService<{ id: string }>(
      `SELECT id::text AS id FROM ${t('orders')} WHERE user_id = $1::uuid AND refund_amount IS NOT NULL ORDER BY id`,
      USER_A,
    )
  ).map(r => r.id)
  for (let i = 0; i < n; i++) {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SELECT pg_stat_force_next_flush()`)
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${ROLE}"`)
      await tx.$executeRawUnsafe(rlsSessionSql(1), ...rlsSessionParams({ userId: USER_A }))
      await tx.$executeRawUnsafe(`UPDATE ${t('orders')} SET refund_reason = $1 WHERE id = $2::uuid`, `${reason} ${i}`, ids[i % ids.length])
    })
  }
}

/** Wait until the statistics collector shows at least `min` updates on orders. */
async function waitForHostUpdates(min: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await prisma.$queryRawUnsafe<Array<{ upd: bigint }>>(
      `SELECT n_tup_upd AS upd FROM pg_stat_user_tables WHERE relid = to_regclass($1)`,
      `${schema}.orders`,
    )
    if (Number(r[0]?.upd ?? 0) >= min) return
    await new Promise(res => setTimeout(res, 500))
  }
  throw new Error(`table statistics never showed ${min} updates on orders`)
}

async function hostUpdates(): Promise<number> {
  const r = await prisma.$queryRawUnsafe<Array<{ upd: bigint }>>(
    `SELECT n_tup_upd AS upd FROM pg_stat_user_tables WHERE relid = to_regclass($1)`,
    `${schema}.orders`,
  )
  return Number(r[0]?.upd ?? 0)
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

/** `count` request-log rows spread evenly over [from, to). */
function requests(count: number, from: Date, to: Date, row: { method: string; path: string; statusCode?: number; duration: number; branchId?: string }) {
  const span = to.getTime() - from.getTime()
  return Array.from({ length: count }, (_, i) => ({
    projectId,
    userId: ownerId,
    method: row.method,
    path: row.path,
    statusCode: row.statusCode ?? 200,
    duration: row.duration,
    branchId: row.branchId ?? null,
    timestamp: new Date(from.getTime() + Math.floor((i / count) * span)),
  }))
}

const BASE = ['id', 'user_id', 'total', 'status', 'created_at', 'shipping_address', 'shipping_method']
const ORDERS_NOW = [...BASE, 'refund_amount', 'refund_reason', 'refunded_at', 'coupon_code', 'discount_amount']
const SAT = ['id', 'order_id', 'refund_amount', 'refund_reason', 'refunded_at']

async function schemaSnapshot(v: number, at: Date, tables: Record<string, string[]>) {
  await prisma.workspaceSchemaSnapshot.create({
    data: {
      projectId,
      versionNum: v,
      trigger: 'post_migration',
      rawDdl: '',
      createdAt: at,
      tables: Object.entries(tables).map(([name, cols]) => ({
        name,
        columns: cols.map(c => ({ name: c, type: 'text', nullable: true, default: null, isPrimary: c === 'id' })),
      })),
    },
  })
}

async function finding(at: Date, type: string, details: object) {
  await prisma.healthFinding.create({ data: { projectId, detectedAt: at, type, severity: 'warning', details, status: 'fixed' } })
}

beforeAll(async () => {
  PGSS = await prisma
    .$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_statements`)
    .then(() => true, () => false)
  ownerId = (await prisma.user.create({
    data: { email: `evo-tm-${randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'evo' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'evolution-telemetry-it', userId: ownerId } })).id
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
  await q(
    `INSERT INTO ${t('orders')} (user_id, total, created_at, refund_amount, refund_reason, refunded_at, coupon_code)
     SELECT CASE WHEN i % 2 = 0 THEN $1::uuid ELSE $2::uuid END, (i % 90) + 10, now() - (i || ' hours')::interval,
            CASE WHEN i % 5 = 0 THEN (i % 40) + 1 END,
            CASE WHEN i % 5 = 0 THEN 'damaged' END,
            CASE WHEN i % 5 = 0 THEN now() - (i || ' hours')::interval + interval '2 days' END,
            CASE WHEN i % 5 = 1 THEN 'SAVE10' END
       FROM generate_series(1, 200) i`,
    USER_A,
    USER_B,
  )
  const svc = `"${schema}"."backenly_jwt_claim"('role') = 'service_role'`
  const sub = `"${schema}"."backenly_jwt_claim"('sub')`
  await q(`ALTER TABLE ${t('orders')} ENABLE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE ${t('orders')} FORCE ROW LEVEL SECURITY`)
  await q(`CREATE POLICY orders_select ON ${t('orders')} FOR SELECT USING (${svc} OR user_id::text = ${sub})`)
  await q(`CREATE POLICY orders_insert ON ${t('orders')} FOR INSERT WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await q(`CREATE POLICY orders_update ON ${t('orders')} FOR UPDATE USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await q(`CREATE POLICY orders_delete ON ${t('orders')} FOR DELETE USING (${svc} OR user_id::text = ${sub})`)
  await q(`CREATE ROLE "${ROLE}" NOLOGIN NOSUPERUSER`)
  await q(`GRANT USAGE ON SCHEMA "${schema}" TO "${ROLE}"`)
  await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t('orders')} TO "${ROLE}"`)
  await q(`ANALYZE ${t('orders')}`)

  // Schema history: refunds arrived 60 days ago (a change to the concern on
  // the host); coupons 20 days ago (not the concern).
  await schemaSnapshot(1, ago(220 * DAY), {})
  await schemaSnapshot(2, ago(200 * DAY), { orders: BASE })
  await schemaSnapshot(3, ago(60 * DAY), { orders: [...BASE, 'refund_amount', 'refund_reason', 'refunded_at'] })
  await schemaSnapshot(4, ago(20 * DAY), { orders: ORDERS_NOW })

  // Repairs: four on a refund column before the change, one on the new table
  // after it. One on a column that is not the concern, and one of Backenly's
  // own approval requests, which is not a repair at all.
  for (const h of [25, 24, 23, 22]) await finding(ago(h * HOUR), 'invalid_value', { tableName: 'orders', columnName: 'refund_amount' })
  await finding(ago(6 * HOUR), 'invalid_value', { table: 'order_refunds', column: 'refund_reason' })
  await finding(ago(6 * HOUR), 'invalid_value', { tableName: 'orders', columnName: 'coupon_code' })
  await finding(ago(6 * HOUR), 'architecture_evolution', { tableName: 'orders', columnName: 'refund_amount' })

  // Traffic BEFORE the change, inside [S0 − 8h, S0): 300 host reads (v1 and
  // v2, three refused 401, two failing 500) at 40ms; 300 host writes at 30ms.
  const b0 = ago(26 * HOUR)
  const b1 = ago(20 * HOUR)
  await prisma.apiRequestLog.createMany({
    data: [
      ...requests(245, b0, b1, { method: 'GET', path: '/db/orders', duration: 40 }),
      ...requests(3, b0, b1, { method: 'GET', path: '/db/orders', duration: 40, statusCode: 401 }),
      ...requests(2, b0, b1, { method: 'GET', path: '/db/orders', duration: 40, statusCode: 500 }),
      ...requests(50, b0, b1, { method: 'GET', path: '/orders', duration: 40 }),
      ...requests(200, b0, b1, { method: 'PATCH', path: `/db/orders/${randomUUID()}`, duration: 30 }),
      ...requests(100, b0, b1, { method: 'POST', path: '/orders', duration: 30 }),
      // Never counted: a preview branch, and the platform's own rows.
      ...requests(50, b0, b1, { method: 'GET', path: '/db/orders', duration: 4000, statusCode: 500, branchId: randomUUID() }),
      ...requests(50, b0, b1, { method: 'GET', path: '/api/ai/chat', duration: 4000, statusCode: 500 }),
      // Another table: counts toward the project, not toward orders.
      ...requests(20, b0, b1, { method: 'GET', path: '/db/customers', duration: 5 }),
    ],
  })
  // AFTER the change, inside [S1, S2): reads unchanged, writes three times
  // slower, a few reads of the new table on v1.
  const a0 = ago(9 * HOUR)
  const a1 = ago(3 * HOUR)
  await prisma.apiRequestLog.createMany({
    data: [
      ...requests(147, a0, a1, { method: 'GET', path: '/db/orders', duration: 40 }),
      ...requests(3, a0, a1, { method: 'GET', path: '/db/orders', duration: 40, statusCode: 500 }),
      ...requests(150, a0, a1, { method: 'GET', path: `/orders/${randomUUID()}`, duration: 40 }),
      ...requests(300, a0, a1, { method: 'PATCH', path: `/orders/${randomUUID()}`, duration: 90 }),
      ...requests(30, a0, a1, { method: 'GET', path: '/db/order_refunds', duration: 10 }),
    ],
  })
  // An hour ago: new clients writing the new table on v2, failing.
  await prisma.apiRequestLog.createMany({
    data: requests(5, ago(70 * 60_000), ago(50 * 60_000), { method: 'POST', path: '/order_refunds', duration: 15, statusCode: 500 }),
  })

  const resolved = await resolveExtractionPlan(projectId, SPEC)
  if (isResolveRefusal(resolved)) throw new Error(resolved.refusal)
  plan = resolved.plan
  const granted = await grantEvolutionApproval({
    projectId, spec: SPEC, planVersion: plan.planVersion, approvedBy: ownerId, resolve: resolveExtractionPlan,
  })
  if (!granted.ok) throw new Error('consent was refused')
}, 120_000)

afterAll(async () => {
  if (originalFlag === undefined) delete process.env.ENABLE_EVOLUTION_MUTATIONS
  else process.env.ENABLE_EVOLUTION_MUTATIONS = originalFlag
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await q(`DROP OWNED BY "${ROLE}"`).catch(() => {})
  await q(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => {})
  await prisma.maintenanceStepExecution.deleteMany({ where: { execution: { projectId } } }).catch(() => {})
  await prisma.maintenanceExecution.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.maintenanceApproval.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.backgroundJob.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiRequestLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeMaintenanceLockPool()
}, 60_000)

// ── The change, with its snapshots taken where the engine takes them ────────

describe('snapshots along the ladder', () => {
  it('R: the host, its statement classes and the concern evidence, before anything exists', async () => {
    snap.R = await snapshotExtraction(projectId, plan, 'R', AT.R)
    const d = data(snap.R)
    expect(snap.R).toMatchObject({ v: 1, phase: 'R', at: AT.R.toISOString() })
    expect(d.tables.host).toMatchObject({ live: expect.any(Number), bytes: expect.any(Number) })
    expect(d.tables.host!.oid).toBeGreaterThan(0)
    expect(d.tables.satellite).toBeNull()
    if (PGSS) {
      // A superuser reads every statement.
      expect(d.pgss.state).toBe('available')
      expect(d.statements).not.toBeNull()
      expect(snap.R.unavailable).toEqual([])
    } else {
      // Not installed, or installed but not preloaded: either way, said.
      expect(['missing', 'unreadable']).toContain(d.pgss.state)
      expect(d.statements).toBeNull()
      expect(snap.R.unavailable).toEqual([expect.objectContaining({ metric: 'statements', reason: 'extension_missing' })])
    }
    // The refunds arriving on orders 60 days ago is a change to the concern on
    // the host; coupons arriving is not. Repairs: the five on member columns
    // (four on orders, one on the satellite), not coupon_code, not Backenly's own request.
    expect(d.concern).toMatchObject({ history: true, satChanges: [], n: [1, 0, 5] })
    expect(d.concern!.hostChanges).toEqual([ago(60 * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z')])
    expect(d.requests).toBeUndefined()
  })

  it('S0: keeps a 7-day request aggregate for the host, on both surfaces, excluding branches and platform rows', async () => {
    await clientWrites(110, 'before')
    snap.S0 = await snapshotExtraction(projectId, plan, 'S0', AT.S0)
    const r = data(snap.S0).requests!
    expect(r.hostRead).toEqual({ n: 300, p50: 40, p95: 40, s5xx: 2, s401: 3, s403: 0 })
    expect(r.hostWrite).toEqual({ n: 300, p50: 30, p95: 30, s5xx: 0, s401: 0, s403: 0 })
    // 600 to orders and 20 to customers; the branch and /api/ rows are not the project's production traffic.
    expect(r.project).toBe(620)
    expect(data(snap.S0).concern).toBeDefined()
  })

  it('runs the extraction for real', async () => {
    process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
    expect((await executeExtraction({ projectId, planId: plan.planId })).status).toBe('awaiting_background_work')
    expect(await drainBackfill()).toBeGreaterThanOrEqual(1)
    expect((await executeExtraction({ projectId, planId: plan.planId })).status).toBe('completed')
  })

  it('S1: the satellite now has counters; no concern evidence or request aggregate at this phase', async () => {
    snap.S1 = await snapshotExtraction(projectId, plan, 'S1', AT.S1)
    const d = data(snap.S1)
    expect(d.tables.satellite!.oid).toBeGreaterThan(0)
    expect(d.tables.satellite!.bytes).toBeGreaterThan(0)
    expect(d.concern).toBeUndefined()
    expect(d.requests).toBeUndefined()

    // The new table's birth, and a later change to it, in schema history.
    await schemaSnapshot(5, ago(9 * HOUR), { orders: ORDERS_NOW, order_refunds: SAT })
    await schemaSnapshot(6, ago(5 * HOUR), { orders: ORDERS_NOW, order_refunds: [...SAT, 'refund_method'] })
  })

  it('S2: after client writes through the sync', async () => {
    const before = await hostUpdates()
    await clientWrites(110, 'after')
    await waitForHostUpdates(before + 110)
    snap.S2 = await snapshotExtraction(projectId, plan, 'S2', AT.S2)
    expect(data(snap.S2).tables.satellite).not.toBeNull()
  })

  it('every snapshot is small enough for an audit row', () => {
    for (const s of Object.values(snap)) expect(JSON.stringify(s).length).toBeLessThan(4096)
  })

  it('reports statement text hidden from a role without pg_read_all_stats, instead of summing nothing', async () => {
    const reading = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${ROLE}"`)
      return readStatementClasses(schema, 'orders', 'order_refunds', (sql, ...p) => tx.$queryRawUnsafe(sql, ...p) as Promise<any>)
    })
    expect(reading.classes).toBeNull()
    if (!PGSS) {
      expect(['missing', 'unreadable']).toContain(reading.state)
      return
    }
    expect(reading.state).toBe('text_hidden')
    expect(reading.hidden).toBeGreaterThan(0)
    expect(reading.detail).toMatch(/pg_read_all_stats/)
  })
})

// ── Observe ──────────────────────────────────────────────────────────────────

describe('observation', () => {
  const signal = (signals: Array<{ name: string; status: string; detail: string }>, name: string) => signals.find(s => s.name === name)!

  it('a consistent extraction observes consistency ok, the satellite present, and no failing requests', async () => {
    const s = await observeExtraction(projectId, plan, { since: AT.S1, now: AT.S2 })
    expect(s.map(x => x.name)).toEqual([CONSISTENCY_SIGNAL, 'satellite_present', 'new_path_errors'])
    expect(signal(s, CONSISTENCY_SIGNAL).status).toBe('ok')
    expect(signal(s, 'satellite_present').status).toBe('ok')
    expect(signal(s, 'new_path_errors')).toEqual({
      name: 'new_path_errors',
      status: 'ok',
      detail: '0 of 30 request(s) to order_refunds since the change failed with a server error',
    })
  })

  it('counts server errors on the new table on the v2 surface too', async () => {
    const s = await observeExtraction(projectId, plan, { since: AT.S1, now: new Date(T) })
    expect(signal(s, 'new_path_errors')).toEqual({
      name: 'new_path_errors',
      status: 'regressed',
      detail: '5 of 35 request(s) to order_refunds since the change failed with a server error',
    })
  })

  it('sees a satellite row deleted behind the triggers\' back', async () => {
    const fk = ladderNames(SPEC).fkColumn
    const [victim] = await asService<{ k: string; row: object }>(
      `SELECT ${fk}::text AS k, to_jsonb(r) AS row FROM ${t('order_refunds')} r ORDER BY ${fk} LIMIT 1`,
    )
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`DELETE FROM ${t('order_refunds')} WHERE ${fk} = $1::uuid`, victim.k)
    })
    const s = await observeExtraction(projectId, plan, { since: AT.S1, now: AT.S2 })
    expect(signal(s, CONSISTENCY_SIGNAL).status).toBe('regressed')
    expect(signal(s, CONSISTENCY_SIGNAL).detail).toMatch(/1 missing/)

    // Put it back the same way, and agreement returns.
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(
        `INSERT INTO ${t('order_refunds')} SELECT * FROM jsonb_populate_record(NULL::${t('order_refunds')}, $1::jsonb)`,
        JSON.stringify(victim.row),
      )
    })
    expect(signal(await observeExtraction(projectId, plan, { since: AT.S1, now: AT.S2 }), CONSISTENCY_SIGNAL).status).toBe('ok')
  })

  it('sees the satellite removed outside Backenly', async () => {
    await q(`ALTER TABLE ${t('order_refunds')} RENAME TO order_refunds_elsewhere`)
    try {
      const s = await observeExtraction(projectId, plan, { since: AT.S1, now: AT.S2 })
      expect(signal(s, 'satellite_present')).toMatchObject({ status: 'regressed', detail: 'order_refunds was removed outside Backenly' })
      expect(signal(s, CONSISTENCY_SIGNAL).status).toBe('unavailable')
    } finally {
      await q(`ALTER TABLE "${schema}"."order_refunds_elsewhere" RENAME TO order_refunds`)
    }
  })
})

// ── Measure ──────────────────────────────────────────────────────────────────

describe('measurement', () => {
  const all = () => [snap.R!, snap.S0!, snap.S1!, snap.S2!]
  let ms: Measurement[] = []

  beforeAll(async () => {
    ms = await measureExtraction(projectId, plan, all(), { firedBy: ['hot_host_change', 'attributed_repairs'], now: AT.S2 })
  })

  it('compares equal request windows on both surfaces: reads held, writes three times slower', () => {
    expect(byName(ms, 'orders read p95')).toMatchObject({ role: 'guardrail', before: 40, after: 40, samplesBefore: 300, samplesAfter: 300 })
    expect(byName(ms, 'orders write p95')).toMatchObject({ role: 'guardrail', before: 30, after: 90, samplesBefore: 300, samplesAfter: 300 })
    expect(byName(ms, 'orders server errors')).toMatchObject({
      unit: 'ratio', before: 2 / 600, after: 3 / 600, samplesBefore: 600, samplesAfter: 600, eventsBefore: 2, eventsAfter: 3,
    })
    expect(byName(ms, 'orders permission refusals')).toMatchObject({ before: 0, after: 0 })
    expect(byName(ms, 'orders read p95').scope).toBe('requests to orders in the 8 hours before the change and the 8 hours after')
  })

  it('measures database time per write from statement-class deltas, or says why it cannot', async () => {
    const m = byName(ms, 'orders write time in the database')
    if (!PGSS) {
      expect(m).toMatchObject({ before: null, after: null, reason: 'extension_missing' })
      return
    }
    // Only evictions INSIDE a measured pair matter: R→S0 and S1→S2. One during
    // the ladder itself, between S0 and S1, is outside both.
    const [r, s0, s1, s2] = all().map(s => data(s).pgss.dealloc)
    if (r === s0 && s1 === s2) {
      // 110 client writes between R and S0, 110 between S1 and S2.
      expect(m).toMatchObject({ unit: 'ms', samplesBefore: 110, samplesAfter: 110, minSamples: 100 })
      expect(m.before).toBeGreaterThan(0)
      expect(m.after).toBeGreaterThan(0)
    } else {
      // pg_stat_statements was full and dropped entries in between (the test
      // database is shared with every other suite): an eviction, never a zero.
      expect(m).toMatchObject({ before: null, after: null, reason: 'statements_evicted' })
    }
    // Either way, the class sums themselves counted exactly the client's
    // writes: Backenly's own statements (the ladder, the backfill, the sync's
    // nested statements) are not in them.
    const unevicted = await measureExtraction(projectId, plan, all().map(steady), { firedBy: [], now: AT.S2 })
    expect(byName(unevicted, 'orders write time in the database')).toMatchObject({ samplesBefore: 110, samplesAfter: 110 })
  })

  it('reports the costs: the new table\'s storage, and the extra rows written per host write', () => {
    const size = byName(ms, 'storage taken by order_refunds')
    expect(size).toMatchObject({ role: 'cost', unit: 'bytes', before: 0 })
    expect(size.after).toBe(data(snap.S2!).tables.satellite!.bytes)
    const amp = byName(ms, 'extra rows written per orders write')
    expect(amp).toMatchObject({ role: 'cost', before: 0 })
    expect(amp.after).toBeGreaterThan(0)
    expect(amp.samplesAfter).toBeGreaterThanOrEqual(110)
  })

  it('hot_host_change: the change to refunds since landed on the new table, and none locked orders', () => {
    expect(byName(ms, 'refund changes that locked orders')).toMatchObject({
      role: 'benefit', unit: 'changes', before: 1, after: 0, samplesBefore: 1, samplesAfter: 1,
      scope: '1 change(s) to refund since the change: 1 on order_refunds, 0 on orders; before it, every one would have locked orders',
    })
  })

  it('attributed_repairs: repairs on refund columns in equal windows before and after', () => {
    expect(byName(ms, 'repairs on refund columns')).toMatchObject({
      role: 'benefit', unit: 'repairs', before: 4, after: 1, samplesBefore: 4, samplesAfter: null, minSamples: 3,
    })
  })

  it('judges it: slower writes make it a regression, whatever it saved', () => {
    const r = assessBenefit(PASS, ms)
    expect(r.verdict).toBe('regressed')
    expect(r.summary).toBe('It made things worse: orders write p95 rose from 30ms to 90ms.')
    // Without that one, it is beneficial on what it was made for.
    const without = assessBenefit(PASS, ms.filter(m => m.name !== 'orders write p95'))
    expect(without.verdict).toBe('beneficial')
    expect(without.summary).toMatch(/^It works correctly\. It helped: refund changes that locked orders went from 1 to 0 .* and repairs on refund columns went from 4 to 1/)
    expect(without.costs.some(c => c.startsWith('storage taken by order_refunds: 0 B → '))).toBe(true)
  })

  it('measures only the benefits that fired the proposal', async () => {
    const none = await measureExtraction(projectId, plan, all(), { firedBy: [], now: AT.S2 })
    expect(none.filter(m => m.role === 'benefit')).toEqual([])
    const one = await measureExtraction(projectId, plan, all(), { firedBy: ['attributed_repairs'], now: AT.S2 })
    expect(one.filter(m => m.role === 'benefit').map(m => m.name)).toEqual(['repairs on refund columns'])
  })

  it('a change to the concern that still lands on the host means the saving has not shown', async () => {
    await schemaSnapshot(7, ago(1 * HOUR), { orders: [...ORDERS_NOW, 'refund_note'], order_refunds: [...SAT, 'refund_method'] })
    const later = await measureExtraction(projectId, plan, all(), { firedBy: ['hot_host_change'], now: new Date(T) })
    expect(byName(later, 'refund changes that locked orders')).toMatchObject({ before: 2, after: 1 })
  })
})

// ── Every missing number has a reason ────────────────────────────────────────

describe('never a fabricated number', () => {
  const S0 = () => snap.S0!
  const write = 'orders write time in the database'
  const amp = 'extra rows written per orders write'

  it('nothing after the change is measurable before it has happened', async () => {
    const ms = await measureExtraction(projectId, plan, [snap.R!, snap.S0!], { firedBy: ['hot_host_change', 'attributed_repairs'], now: AT.S2 })
    for (const m of ms) {
      expect([m.before, m.after]).toContain(null)
      expect(m.reason).toBe('not_yet_measurable')
      expect(m.unavailableReason).toBeTruthy()
    }
  })

  it('statement deltas: a reset, an eviction, a missing extension or hidden text is a reason, not a zero', async () => {
    // Each case changes one thing on snapshots that otherwise saw no eviction.
    const [R, S0s, S1, S2] = [snap.R!, S0(), snap.S1!, snap.S2!].map(steady)
    const run = async (r: TelemetrySnapshot, s0: TelemetrySnapshot, s2 = S2) =>
      byName(await measureExtraction(projectId, plan, [r, s0, S1, s2], { firedBy: [], now: AT.S2 }), write)
    if (!PGSS) {
      // Without the extension every snapshot already says so, and nothing a
      // later reading could say changes that.
      expect(await run(R, S0s)).toMatchObject({ before: null, after: null, reason: 'extension_missing' })
      return
    }

    expect((await run(R, S0s)).before).not.toBeNull()
    expect(await run(R, clone(S0s, d => { d.pgss.statsReset = '2026-01-01T00:00:00.000Z' }))).toMatchObject({ before: null, reason: 'stats_reset' })
    expect(await run(R, clone(S0s, d => { d.pgss.dealloc = 1 }))).toMatchObject({ before: null, reason: 'statements_evicted' })
    expect(await run(clone(R, d => { d.pgss.state = 'missing'; d.statements = null }), S0s)).toMatchObject({ reason: 'extension_missing' })
    expect(await run(R, S0s, clone(S2, d => { d.pgss.state = 'text_hidden'; d.statements = null }))).toMatchObject({
      reason: 'statement_text_hidden',
    })
    expect(await run(R, clone(S0s, d => { d.statements!.hostWrite.calls = -1 }))).toMatchObject({ reason: 'stats_reset' })
    expect(await run(R, clone(S0s, d => { d.tables.host!.oid += 1 }))).toMatchObject({ reason: 'relation_recreated' })
  })

  it('table deltas: a reset, a recreated table or a counter going backwards is a reason, not a zero', async () => {
    const run = async (s2: TelemetrySnapshot) =>
      byName(await measureExtraction(projectId, plan, [snap.R!, S0(), snap.S1!, s2], { firedBy: [], now: AT.S2 }), amp)
    expect(await run(clone(snap.S2!, d => { d.db.statsReset = '2026-01-01T00:00:00.000Z' }))).toMatchObject({ after: null, reason: 'stats_reset' })
    expect(await run(clone(snap.S2!, d => { d.tables.satellite!.oid += 1 }))).toMatchObject({ reason: 'relation_recreated' })
    expect(await run(clone(snap.S2!, d => { d.tables.host!.upd = data(snap.S1!).tables.host!.upd - 1 }))).toMatchObject({ reason: 'stats_reset' })
  })

  it('a window with no traffic, or no traffic to the table, says which', async () => {
    // Twelve to fifteen days ago: nothing recorded at all…
    const at = (phase: 'S0' | 'S1', d: Date) => clone(phase === 'S0' ? S0() : snap.S1!, (_, s) => { s.at = d.toISOString() })
    const quiet = await measureExtraction(projectId, plan, [snap.R!, at('S0', ago(14 * DAY)), at('S1', ago(13 * DAY))], {
      firedBy: [], now: ago(12 * DAY),
    })
    expect(byName(quiet, 'orders read p95')).toMatchObject({ before: null, reason: 'no_traffic_recorded' })

    // …then requests to another table only.
    await prisma.apiRequestLog.createMany({
      data: [
        ...requests(10, ago(15 * DAY), ago(14 * DAY), { method: 'GET', path: '/db/customers', duration: 5 }),
        ...requests(10, ago(13 * DAY), ago(12 * DAY), { method: 'GET', path: '/customers', duration: 5 }),
      ],
    })
    const elsewhere = await measureExtraction(projectId, plan, [snap.R!, at('S0', ago(14 * DAY)), at('S1', ago(13 * DAY))], {
      firedBy: [], now: ago(12 * DAY),
    })
    expect(byName(elsewhere, 'orders server errors')).toMatchObject({ before: null, reason: 'table_not_served_over_api' })
  })

  it('past the request log\'s retention, compares with the aggregate kept at S0 and says the windows differ', async () => {
    const s0 = clone(S0(), (_, s) => { s.at = ago(40 * DAY).toISOString() })
    const s1 = clone(snap.S1!, (_, s) => { s.at = ago(39 * DAY).toISOString() })
    const old = await measureExtraction(projectId, plan, [s0, s1], { firedBy: [], now: new Date(T) })
    const read = byName(old, 'orders read p95')
    expect(read).toMatchObject({ before: 40, samplesBefore: 300 })
    expect(read.scope).toMatch(/kept when it started/)
    expect(read.scope).toMatch(/not the same length/)

    const lost = await measureExtraction(projectId, plan, [clone(s0, d => { delete d.requests }), s1], { firedBy: [], now: new Date(T) })
    expect(byName(lost, 'orders read p95')).toMatchObject({ before: null, reason: 'window_aged_out' })
  })

  it('repairs that could not be read are a reason, not zero repairs', async () => {
    // A read failure is simulated; everything else is the real database.
    const spy = jest.spyOn(prisma.healthFinding, 'findMany').mockRejectedValueOnce(new Error('connection reset'))
    try {
      const ms = await measureExtraction(projectId, plan, [snap.R!, S0(), snap.S1!, snap.S2!], { firedBy: ['attributed_repairs'], now: AT.S2 })
      expect(byName(ms, 'repairs on refund columns')).toMatchObject({ before: null, after: null, reason: 'history_unreadable' })
    } finally {
      spy.mockRestore()
    }
  })

  it('the concern not changing since is "too early", not "no benefit"', async () => {
    // Measured before the satellite's first change (v6, five hours ago).
    const early = await measureExtraction(projectId, plan, all6h(), { firedBy: ['hot_host_change'], now: ago(6 * HOUR) })
    expect(byName(early, 'refund changes that locked orders')).toMatchObject({
      before: null,
      reason: 'insufficient_sample',
      unavailableReason: 'refund has not changed since the change; the saving shows when it does',
    })
  })

  function all6h(): TelemetrySnapshot[] {
    return [snap.R!, S0(), snap.S1!]
  }
})
