/**
 * THE DUAL REPRESENTATION UNDER CONCURRENCY — never two answers at once
 * =====================================================================
 *
 * While an extraction is live, a refund exists in two places: `orders`
 * (written by every client that existed before) and `order_refunds` (written by
 * new clients). The guarantee these tests pin is the one the whole engine rests
 * on: whatever the interleaving, a COMMITTED state never has
 * `orders.refund_amount = 20` beside `order_refunds.refund_amount = 40`. Either
 * a transaction commits with both equal, or it does not commit.
 *
 * Every scenario runs on real connections in real PostgreSQL, with real row
 * locks, real deadlock detection and real lock timeouts — interleavings are
 * forced, not hoped for:
 *
 *   - two old writers, two new writers, old-then-new, new-then-old
 *   - the crossing deadlock (old holds orders, new holds order_refunds), with
 *     each side steered to be the victim, and the survivor then rolling back
 *   - a lock timeout inside the forward mirror (it used to be swallowed and
 *     commit a divergence)
 *   - the backfill meeting a row being written: it never waits, retries, and
 *     gives up to the job queue rather than queueing writers behind it
 *   - integer keys across several batches (the cursor used to sort as text)
 *   - a parent's key changing (ON UPDATE CASCADE), a client moving a refund to
 *     another order, a host trigger rewriting a value written through the
 *     satellite, a savepoint rolled back mid-sync, TRUNCATE, and the satellite
 *     dropped by hand
 *   - a randomized storm of old and new writers on a few hot rows
 *
 * The local role is a superuser, so row-level security is not what is under
 * test here (tests/integration/structural-evolution.spec.ts covers access);
 * locking, triggers and transactions are.
 */

import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { closeMaintenanceLockPool } from '@/lib/autonomy/maintenance/single-flight'
import { resolveExtractionPlan, isResolveRefusal } from '@/lib/structural-evolution/resolve'
import { grantEvolutionApproval, isGrantRefusal } from '@/lib/structural-evolution/consent'
import { executeExtraction } from '@/lib/structural-evolution/execute'
import { handleEvolutionBackfillJob, LOCKED_ROW_RETRY_MS } from '@/lib/structural-evolution/backfill-job'
import { reconcileExtraction } from '@/lib/structural-evolution/reconcile'
import { readTableFacts, basisFingerprint } from '@/lib/structural-evolution/facts'
import { backfillBatchSql, type ExtractionSpec } from '@/lib/structural-evolution/sql'
import { BACKFILL_BATCH_ROWS } from '@/lib/structural-evolution/plan'

// Every wait below is bounded; a regression fails a test instead of hanging the suite.
jest.setTimeout(60_000)

const SPEC: ExtractionSpec = {
  host: 'orders',
  members: ['refund_amount', 'refund_reason', 'refunded_at'],
  satellite: 'order_refunds',
  label: 'refund',
}
const ROWS = 2_500

let ownerId = ''
let projectId = ''
let schema = ''
let planId = ''
let planVersion = ''
const originalFlag = process.env.ENABLE_EVOLUTION_MUTATIONS
const clients: Client[] = []
/** Backend pid of each client, read once at connect: a busy client cannot be asked later. */
const pids = new WeakMap<Client, number>()

const q = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p)
const t = (name: string) => `"${schema}"."${name}"`

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  // A backend terminated by the cleanup below reports here, not as a crash.
  c.on('error', () => {})
  await c.connect()
  clients.push(c)
  pids.set(c, (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  return c
}

/** A promise that must settle within `ms`, or the test fails saying what it was waiting for. */
function within<T>(p: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

// Whatever a scenario left open — a blocked statement, a transaction a failed
// assertion never ended — is terminated, so one failure cannot hang the next.
afterEach(async () => {
  for (const c of clients.splice(0)) {
    await prisma
      .$queryRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND state <> 'idle'`, pidOf(c))
      .catch(() => {})
    await c.end().catch(() => {})
  }
})

const pidOf = (c: Client): number => pids.get(c)!

/** Wait until a backend is waiting on `event` (a lock, a sleep). Polls the catalog; never sleeps blind. */
async function waitUntil(pid: number, event: 'Lock' | 'PgSleep', timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await prisma.$queryRawUnsafe<Array<{ t: string | null; e: string | null }>>(
      `SELECT wait_event_type AS t, wait_event AS e FROM pg_stat_activity WHERE pid = $1`,
      pid,
    )
    const row = r[0]
    if (row && (event === 'Lock' ? row.t === 'Lock' : row.e === 'PgSleep')) return
    if (Date.now() > deadline) throw new Error(`backend ${pid} never reached ${event} (now ${row?.t}/${row?.e})`)
    await new Promise(res => setTimeout(res, 20))
  }
}

/** A query that settles to its error (or null), so a blocked statement can be awaited later. */
const settle = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; message?: string }) => e)

async function valuesOf(key: number): Promise<{ host: string; sat: string | null }> {
  const h = await prisma.$queryRawUnsafe<Array<{ v: string }>>(
    `SELECT ROW(refund_amount, refund_reason, refunded_at)::text AS v FROM ${t('orders')} WHERE id = $1`,
    key,
  )
  const s = await prisma.$queryRawUnsafe<Array<{ v: string }>>(
    `SELECT ROW(refund_amount, refund_reason, refunded_at)::text AS v FROM ${t('order_refunds')} WHERE order_id = $1`,
    key,
  )
  return { host: h[0]?.v ?? '(missing)', sat: s[0]?.v ?? null }
}

/** Equal in both places: the same values, or no refund and no satellite row. */
function agree(v: { host: string; sat: string | null }): boolean {
  return v.sat === null ? v.host === '(,,)' : v.host === v.sat
}

async function consistent(): Promise<void> {
  const r = await reconcileExtraction(projectId, (await readTableFacts(schema, 'orders'))!, SPEC)
  expect(r.summary).toMatch(/match/)
  expect(r.consistent).toBe(true)
}

/** A key that carries a refund, distinct per scenario so one cannot mask another. */
let nextKey = 5
const refundKey = () => {
  nextKey += 5
  return nextKey
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `evo-cc-${randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'evo-cc' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'evolution-concurrency', userId: ownerId } })).id
  schema = await resolveWorkspaceSchema(projectId)

  await q(`CREATE SCHEMA "${schema}"`)
  // Integer keys on purpose: the batch cursor once sorted them as text.
  await q(`CREATE TABLE ${t('orders')} (
    id bigint PRIMARY KEY,
    total numeric NOT NULL,
    refund_amount numeric CHECK (refund_amount >= 0),
    refund_reason text,
    refunded_at timestamptz
  )`)
  await q(
    `INSERT INTO ${t('orders')} (id, total, refund_amount, refund_reason, refunded_at)
     SELECT i, i % 90 + 10,
            CASE WHEN i % 5 = 0 THEN i % 40 + 1 END,
            CASE WHEN i % 5 = 0 THEN 'damaged' END,
            CASE WHEN i % 5 = 0 THEN now() - (i || ' minutes')::interval END
       FROM generate_series(1, ${ROWS}) i`,
  )

  process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
  const resolved = await resolveExtractionPlan(projectId, SPEC)
  if (isResolveRefusal(resolved)) throw new Error(resolved.refusal)
  planId = resolved.plan.planId
  planVersion = resolved.plan.planVersion
  expect(resolved.plan.validity).toBe('executable')
  const granted = await grantEvolutionApproval({
    projectId, spec: SPEC, planVersion, approvedBy: ownerId, resolve: resolveExtractionPlan,
  })
  if (isGrantRefusal(granted)) throw new Error(granted.refusal)

  const first = await executeExtraction({ projectId, planId })
  expect(first.status).toBe('awaiting_background_work')
}, 120_000)

afterAll(async () => {
  for (const c of clients) await c.end().catch(() => {})
  if (originalFlag === undefined) delete process.env.ENABLE_EVOLUTION_MUTATIONS
  else process.env.ENABLE_EVOLUTION_MUTATIONS = originalFlag
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.maintenanceStepExecution.deleteMany({ where: { execution: { projectId } } }).catch(() => {})
  await prisma.maintenanceExecution.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.maintenanceApproval.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.backgroundJob.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeMaintenanceLockPool()
}, 60_000)

describe('the backfill', () => {
  it('walks integer keys in key order, one batch per thousand rows, never re-reading a batch', async () => {
    const seen: Array<string | null> = []
    let batches = 0
    for (let i = 0; i < 10; i++) {
      const job = await prisma.backgroundJob.findFirst({
        where: { projectId, type: 'evolution_backfill', status: 'queued' },
        orderBy: { createdAt: 'asc' },
      })
      if (!job) break
      const result = await handleEvolutionBackfillJob(job.payload as any)
      seen.push(result.cursor)
      batches++
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { status: 'completed', result: result as object, completedAt: new Date() },
      })
    }
    expect(batches).toBe(Math.ceil(ROWS / BACKFILL_BATCH_ROWS))
    // Numeric, not text: '999' would sort above '1000'.
    expect(seen).toEqual(['1000', '2000', '2500'])

    const out = await executeExtraction({ projectId, planId })
    expect(out.status).toBe('completed')
    await consistent()
  })

  it('never waits for a row being written: the batch fails fast instead of queueing writers behind it', async () => {
    const writer = await connect()
    await writer.query('BEGIN')
    await writer.query(`UPDATE ${t('orders')} SET total = total WHERE id = 3`)
    const facts = (await readTableFacts(schema, 'orders'))!
    const started = Date.now()
    const err = await settle(
      prisma.$transaction(tx => tx.$queryRawUnsafe(backfillBatchSql(facts, SPEC, { schema }, BACKFILL_BATCH_ROWS), null)),
    )
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(String((err as Error)?.message)).toMatch(/55P03|could not obtain lock/)
    await writer.query('ROLLBACK')
  })

  it('retries a batch that met a locked row, and succeeds once the writer is done', async () => {
    const writer = await connect()
    await writer.query('BEGIN')
    await writer.query(`UPDATE ${t('orders')} SET total = total WHERE id = 4`)
    const facts = (await readTableFacts(schema, 'orders'))!
    const payload = { projectId, planId, planVersion, basisFingerprint: basisFingerprint(facts), spec: SPEC, cursor: null }
    const run = handleEvolutionBackfillJob(payload)
    // Released after the first retry wait, before the last.
    setTimeout(() => void writer.query('COMMIT'), LOCKED_ROW_RETRY_MS[0] + 150)
    const result = await run
    expect(result.refusal).toBeUndefined()
    expect(result.scanned).toBe(BACKFILL_BATCH_ROWS)
    await prisma.backgroundJob.deleteMany({ where: { projectId, type: 'evolution_backfill', status: 'queued' } })
  })

  it('hands a row that stays locked to the job queue rather than waiting on it', async () => {
    const writer = await connect()
    await writer.query('BEGIN')
    await writer.query(`UPDATE ${t('orders')} SET total = total WHERE id = 6`)
    const facts = (await readTableFacts(schema, 'orders'))!
    const payload = { projectId, planId, planVersion, basisFingerprint: basisFingerprint(facts), spec: SPEC, cursor: null }
    const err = await settle(handleEvolutionBackfillJob(payload))
    expect(String((err as Error)?.message)).toMatch(/55P03|could not obtain lock/)
    await writer.query('ROLLBACK')
  })
})

describe('two writers of the same refund', () => {
  it('old then old: the later commit wins, in both places', async () => {
    const k = refundKey()
    const a = await connect()
    const b = await connect()
    await a.query('BEGIN')
    await a.query(`UPDATE ${t('orders')} SET refund_amount = 20 WHERE id = $1`, [k])
    await b.query('BEGIN')
    const pending = settle(b.query(`UPDATE ${t('orders')} SET refund_amount = 40 WHERE id = $1`, [k]))
    await waitUntil(pidOf(b), 'Lock')
    await a.query('COMMIT')
    expect(await within(pending, 'the waiting writer to proceed')).toBeNull()
    await b.query('COMMIT')
    const v = await valuesOf(k)
    expect(v.host).toMatch(/^\(40,/)
    expect(agree(v)).toBe(true)
  })

  it('new then new: the later commit wins, in both places', async () => {
    const k = refundKey()
    const a = await connect()
    const b = await connect()
    await a.query('BEGIN')
    await a.query(`UPDATE ${t('order_refunds')} SET refund_amount = 20 WHERE order_id = $1`, [k])
    await b.query('BEGIN')
    const pending = settle(b.query(`UPDATE ${t('order_refunds')} SET refund_amount = 40 WHERE order_id = $1`, [k]))
    await waitUntil(pidOf(b), 'Lock')
    await a.query('COMMIT')
    expect(await within(pending, 'the waiting writer to proceed')).toBeNull()
    await b.query('COMMIT')
    const v = await valuesOf(k)
    expect(v.host).toMatch(/^\(40,/)
    expect(agree(v)).toBe(true)
  })

  it('old writes 20, new writes 40: the new client waits, then wins in both places', async () => {
    const k = refundKey()
    const old = await connect()
    const neu = await connect()
    await old.query('BEGIN')
    await old.query(`UPDATE ${t('orders')} SET refund_amount = 20 WHERE id = $1`, [k])
    await neu.query('BEGIN')
    const pending = settle(neu.query(`UPDATE ${t('order_refunds')} SET refund_amount = 40 WHERE order_id = $1`, [k]))
    await waitUntil(pidOf(neu), 'Lock')
    await old.query('COMMIT')
    expect(await within(pending, 'the waiting writer to proceed')).toBeNull()
    await neu.query('COMMIT')
    const v = await valuesOf(k)
    expect(v.host).toMatch(/^\(40,/)
    expect(agree(v)).toBe(true)
  })

  it('new writes 40, old writes 20: the old client waits, then wins in both places', async () => {
    const k = refundKey()
    const old = await connect()
    const neu = await connect()
    await neu.query('BEGIN')
    await neu.query(`UPDATE ${t('order_refunds')} SET refund_amount = 40 WHERE order_id = $1`, [k])
    await old.query('BEGIN')
    const pending = settle(old.query(`UPDATE ${t('orders')} SET refund_amount = 20 WHERE id = $1`, [k]))
    await waitUntil(pidOf(old), 'Lock')
    await neu.query('COMMIT')
    expect(await within(pending, 'the waiting writer to proceed')).toBeNull()
    await old.query('COMMIT')
    const v = await valuesOf(k)
    expect(v.host).toMatch(/^\(20,/)
    expect(agree(v)).toBe(true)
  })
})

describe('the crossing deadlock', () => {
  // A new client that has locked its order_refunds row and pauses before the
  // reverse sync reaches orders; meanwhile an old client locks orders and its
  // forward mirror wants the order_refunds row. Each holds what the other
  // needs. The pause is a BEFORE trigger that sleeps only in sessions that ask
  // it to, so the interleaving is forced rather than raced for.
  beforeAll(async () => {
    await q(`CREATE FUNCTION ${t('bkn_test_pause')}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('bkn_test.pause', true) = '1' THEN PERFORM pg_sleep(1); END IF;
        RETURN NEW;
      END $$`)
    await q(`CREATE TRIGGER bkn_test_pause BEFORE UPDATE ON ${t('order_refunds')} FOR EACH ROW EXECUTE FUNCTION ${t('bkn_test_pause')}()`)
  })
  afterAll(async () => {
    await q(`DROP TRIGGER IF EXISTS bkn_test_pause ON ${t('order_refunds')}`)
    await q(`DROP FUNCTION IF EXISTS ${t('bkn_test_pause')}()`)
  })

  /** Both writers in flight and deadlocked; returns the two pending statements. */
  async function cross(k: number, victim: 'old' | 'new') {
    const old = await connect()
    const neu = await connect()
    await neu.query('BEGIN')
    await neu.query(`SET LOCAL bkn_test.pause = '1'`)
    await neu.query(`SET LOCAL deadlock_timeout = '${victim === 'new' ? '200ms' : '30s'}'`)
    const newWrite = settle(neu.query(`UPDATE ${t('order_refunds')} SET refund_amount = 40 WHERE order_id = $1`, [k]))
    await waitUntil(pidOf(neu), 'PgSleep')
    await old.query('BEGIN')
    await old.query(`SET LOCAL deadlock_timeout = '${victim === 'old' ? '1500ms' : '30s'}'`)
    const oldWrite = settle(old.query(`UPDATE ${t('orders')} SET refund_amount = 20 WHERE id = $1`, [k]))
    return { old, neu, oldWrite, newWrite }
  }

  it('aborts the old writer whole when it is the victim; the new writer rolling back leaves both as they were', async () => {
    const k = refundKey()
    const before = await valuesOf(k)
    const { old, neu, oldWrite, newWrite } = await cross(k, 'old')
    const oldErr = (await within(oldWrite, 'the old writer to be chosen as the deadlock victim')) as { code?: string } | null
    // A client whose statement succeeded commits. Before fail-closed the
    // deadlock was caught inside the forward mirror, so this COMMIT put 20 in
    // orders with no mirror, and the rollback below left it beside the
    // original value in order_refunds.
    await old.query(oldErr ? 'ROLLBACK' : 'COMMIT')
    const newErr = await within(newWrite, 'the new writer to proceed once the old one ended')
    await neu.query('ROLLBACK')
    const after = await valuesOf(k)
    expect(agree(after)).toBe(true)
    expect(after).toEqual(before)
    expect(oldErr?.code).toBe('40P01')
    expect(newErr).toBeNull()
  })

  it('aborts the new writer whole when it is the victim; the old value lands in both', async () => {
    const k = refundKey()
    const { old, neu, oldWrite, newWrite } = await cross(k, 'new')
    const newErr = (await within(newWrite, 'the new writer to be chosen as the deadlock victim')) as { code?: string } | null
    await neu.query('ROLLBACK')
    const oldErr = await within(oldWrite, 'the old writer to proceed once the new one ended')
    await old.query(oldErr ? 'ROLLBACK' : 'COMMIT')
    const after = await valuesOf(k)
    expect(agree(after)).toBe(true)
    expect(after.host).toMatch(/^\(20,/)
    expect(newErr?.code).toBe('40P01')
    expect(oldErr).toBeNull()
  })
})

describe('the forward mirror is fail-closed', () => {
  it('a lock timeout inside it fails the write to orders instead of committing it alone', async () => {
    const k = refundKey()
    const before = await valuesOf(k)
    const holder = await connect()
    const old = await connect()
    // Holds the order_refunds row and nothing else.
    await holder.query('BEGIN')
    await holder.query(`SELECT 1 FROM ${t('order_refunds')} WHERE order_id = $1 FOR UPDATE`, [k])
    await old.query('BEGIN')
    await old.query(`SET LOCAL lock_timeout = '300ms'`)
    const err = (await within(
      settle(old.query(`UPDATE ${t('orders')} SET refund_amount = 20 WHERE id = $1`, [k])),
      'the old write to give up on the locked mirror row',
    )) as { code?: string } | null
    // A client whose statement succeeded commits — which, with the timeout
    // swallowed, is exactly how orders and order_refunds used to part ways.
    await old.query(err ? 'ROLLBACK' : 'COMMIT')
    await holder.query('COMMIT')
    const after = await valuesOf(k)
    expect(agree(after)).toBe(true)
    expect(after).toEqual(before)
    expect(err?.code).toBe('55P03')
  })

  it('lets orders be written when the satellite was removed by hand: there is nothing left to disagree with', async () => {
    // Run last in spirit: it uses a throwaway copy, not the live satellite.
    const k = refundKey()
    await q(`ALTER TABLE ${t('order_refunds')} RENAME TO order_refunds_aside`)
    try {
      await expect(q(`UPDATE ${t('orders')} SET refund_amount = 9 WHERE id = $1`, k)).resolves.toBe(1)
    } finally {
      await q(`ALTER TABLE ${t('order_refunds_aside')} RENAME TO order_refunds`)
      // Put the mirror back in step for the scenarios after this one.
      await q(`UPDATE ${t('orders')} SET refund_amount = refund_amount + 0 WHERE id = $1`, k)
      await q(`UPDATE ${t('order_refunds')} SET refund_amount = 9 WHERE order_id = $1`, k)
    }
    expect(agree(await valuesOf(k))).toBe(true)
  })
})

describe('edges of the sync', () => {
  it("follows a parent's key changing (ON UPDATE CASCADE) instead of refusing it", async () => {
    const k = refundKey()
    const moved = 1_000_000 + k
    await expect(q(`UPDATE ${t('orders')} SET id = $1 WHERE id = $2`, moved, k)).resolves.toBe(1)
    expect(agree(await valuesOf(moved))).toBe(true)
    expect((await valuesOf(moved)).sat).not.toBeNull()
    await consistent()
  })

  it('still refuses a client moving a refund to another order', async () => {
    const k = refundKey()
    const bare = k + 1 // keys not divisible by five carry no refund
    const err = await settle(q(`UPDATE ${t('order_refunds')} SET order_id = $1 WHERE order_id = $2`, bare, k))
    expect(String((err as Error)?.message)).toMatch(/cannot change while orders still carries these columns/)
  })

  it('takes what orders stored when a trigger on orders rewrites a value written through order_refunds', async () => {
    const k = refundKey()
    await q(`CREATE FUNCTION ${t('bkn_test_lower')}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.refund_reason := lower(NEW.refund_reason); RETURN NEW; END $$`)
    await q(`CREATE TRIGGER bkn_test_lower BEFORE UPDATE ON ${t('orders')} FOR EACH ROW EXECUTE FUNCTION ${t('bkn_test_lower')}()`)
    try {
      await q(`UPDATE ${t('order_refunds')} SET refund_reason = 'DAMAGED IN TRANSIT' WHERE order_id = $1`, k)
      const v = await valuesOf(k)
      expect(v.host).toMatch(/damaged in transit/)
      expect(agree(v)).toBe(true)
    } finally {
      await q(`DROP TRIGGER bkn_test_lower ON ${t('orders')}`)
      await q(`DROP FUNCTION ${t('bkn_test_lower')}()`)
    }
  })

  it('a savepoint rolled back mid-sync does not leave the echo guard set for the rest of the transaction', async () => {
    const k = refundKey()
    const other = refundKey()
    await q(`CREATE FUNCTION ${t('bkn_test_boom')}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.refund_reason = 'boom' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`)
    await q(`CREATE TRIGGER bkn_test_boom BEFORE UPDATE ON ${t('orders')} FOR EACH ROW EXECUTE FUNCTION ${t('bkn_test_boom')}()`)
    const c = await connect()
    try {
      await c.query('BEGIN')
      await c.query('SAVEPOINT a')
      // The reverse sync sets its guard, then the write to orders fails.
      await expect(c.query(`UPDATE ${t('order_refunds')} SET refund_reason = 'boom' WHERE order_id = $1`, [k])).rejects.toThrow(/boom/)
      await c.query('ROLLBACK TO SAVEPOINT a')
      // If the guard had survived, this write would not be mirrored.
      await c.query(`UPDATE ${t('orders')} SET refund_amount = 33 WHERE id = $1`, [other])
      await c.query('COMMIT')
    } finally {
      await q(`DROP TRIGGER bkn_test_boom ON ${t('orders')}`)
      await q(`DROP FUNCTION ${t('bkn_test_boom')}()`)
    }
    const v = await valuesOf(other)
    expect(v.sat).toMatch(/^\(33,/)
    expect(agree(v)).toBe(true)
  })

  it('refuses TRUNCATE of the satellite, which row triggers would never see', async () => {
    const err = await settle(q(`TRUNCATE ${t('order_refunds')}`))
    expect(String((err as Error)?.message)).toMatch(/cannot be truncated/)
    await consistent()
  })

  it('setting every member empty through orders removes the satellite row; setting one back recreates it', async () => {
    const k = refundKey()
    await q(`UPDATE ${t('orders')} SET refund_amount = NULL, refund_reason = NULL, refunded_at = NULL WHERE id = $1`, k)
    expect((await valuesOf(k)).sat).toBeNull()
    await q(`UPDATE ${t('orders')} SET refund_reason = 'late' WHERE id = $1`, k)
    expect(agree(await valuesOf(k))).toBe(true)
    expect((await valuesOf(k)).sat).not.toBeNull()
  })
})

describe('a storm of old and new writers on a few hot rows', () => {
  it('ends with both representations equal, whatever aborted along the way', async () => {
    const hot = [refundKey(), refundKey(), refundKey(), refundKey()]
    const WORKERS = 6
    const OPS = 40
    let committed = 0
    let aborted = 0
    const worker = async (w: number) => {
      const c = await connect()
      await c.query(`SET deadlock_timeout = '50ms'`)
      for (let i = 0; i < OPS; i++) {
        const k = hot[(w * 7 + i * 3) % hot.length]
        const k2 = hot[(w + i) % hot.length]
        const amount = (w * 100 + i) % 50
        try {
          await c.query('BEGIN')
          if ((w + i) % 2 === 0) {
            await c.query(`UPDATE ${t('orders')} SET refund_amount = $1 WHERE id = $2`, [amount, k])
            await c.query(`UPDATE ${t('order_refunds')} SET refund_reason = $1 WHERE order_id = $2`, [`w${w}`, k2])
          } else {
            await c.query(`UPDATE ${t('order_refunds')} SET refund_amount = $1 WHERE order_id = $2`, [amount, k])
            await c.query(`UPDATE ${t('orders')} SET refund_reason = $1 WHERE id = $2`, [`w${w}`, k2])
          }
          await c.query('COMMIT')
          committed++
        } catch (err) {
          // Deadlocks are expected here; anything else is a failure of the sync.
          expect((err as { code?: string }).code).toBe('40P01')
          await c.query('ROLLBACK')
          aborted++
        }
      }
    }
    await within(Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w))), 'the storm to finish', 45_000)
    expect(committed).toBeGreaterThan(0)
    expect(committed + aborted).toBe(WORKERS * OPS)
    for (const k of hot) expect(agree(await valuesOf(k))).toBe(true)
    await consistent()
  })
})
