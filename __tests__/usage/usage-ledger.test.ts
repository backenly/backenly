/**
 * THE USAGE LEDGER COUNTS EVERYTHING EXACTLY ONCE
 * ================================================
 * Billing-grade metering has three ways to go wrong, and each is asserted here
 * against a real database:
 *
 *   loss        a failed write, or a shutdown, silently drops usage
 *   double      a retry after an ambiguous failure, or a replayed spool, counts
 *               the same usage twice
 *   drift       a closed month changes after it closed, or a second close adds
 *               a second total
 *
 * The ledger seals usage into batches whose id is inserted in the same
 * transaction as their increments (usage_applied_batches), spools unconfirmed
 * batches synchronously on shutdown, and the monthly close is insert-only.
 */

import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db/prisma'
import { UsageLedger, applyUsageBatch, type LedgerBatch } from '@/lib/usage/ledger'
import { closePeriod, computePeriodTotals } from '@/lib/usage/close'

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const createdUsers: string[] = []
const createdProjects: string[] = []
const batchIds: string[] = []
const spoolDirs: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

async function makeOwnerWithProjects(n: number) {
  const user = await prisma.user.create({
    data: { email: `usage-${randomUUID()}@test.invalid`, name: 'Usage Test' },
    select: { id: true },
  })
  createdUsers.push(user.id)
  const projects: string[] = []
  for (let i = 0; i < n; i++) {
    const p = await prisma.project.create({
      data: { name: `usage-${randomUUID().slice(0, 8)}`, userId: user.id },
      select: { id: true },
    })
    createdProjects.push(p.id)
    projects.push(p.id)
  }
  return { userId: user.id, projects }
}

function tmpSpool(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-spool-test-'))
  spoolDirs.push(d)
  return d
}

function ledger(spoolDir = tmpSpool(), db?: any) {
  return new UsageLedger({ spoolDir, autoFlush: false, ...(db ? { db } : {}) })
}

const rowsFor = (projectId: string) =>
  prisma.usageDaily.findMany({ where: { projectId }, orderBy: [{ axis: 'asc' }, { source: 'asc' }] })

async function track<T extends { id: string }>(b: T): Promise<T> {
  batchIds.push(b.id)
  return b
}

beforeAll(() => assertSafeTestDatabase())

afterAll(async () => {
  await prisma.usageDaily.deleteMany({ where: { projectId: { in: createdProjects } } })
  await prisma.usagePeriodClose.deleteMany({ where: { billingAccountId: { in: createdUsers } } })
  await prisma.userAiUsage.deleteMany({ where: { userId: { in: createdUsers } } })
  await prisma.$executeRaw`DELETE FROM "usage_applied_batches" WHERE "id" = ANY(${batchIds}::text[])`
  await prisma.project.deleteMany({ where: { id: { in: createdProjects } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } })
  for (const d of spoolDirs) fs.rmSync(d, { recursive: true, force: true })
})

// ============================================================================
// RECORDING
// ============================================================================

describe('recording', () => {
  it('adds counters and keeps the maximum of gauges, per project, axis, day and source', async () => {
    const { userId, projects: [p] } = await makeOwnerWithProjects(1)
    const l = ledger()
    l.record({ projectId: p, axis: 'egress_bytes', quantity: 1000, source: 'app' })
    l.record({ projectId: p, axis: 'egress_bytes', quantity: 234, source: 'app' })
    l.record({ projectId: p, axis: 'egress_bytes', quantity: 50, source: 's3' })
    l.record({ projectId: p, axis: 'db_bytes', quantity: 7000, source: 'pg' })
    l.record({ projectId: p, axis: 'db_bytes', quantity: 9000, source: 'pg' })
    l.record({ projectId: p, axis: 'db_bytes', quantity: 8000, source: 'pg' })
    await l.flush()

    const rows = await rowsFor(p)
    const q = (axis: string, source: string) => rows.find((r) => r.axis === axis && r.source === source)?.quantity
    expect(q('egress_bytes', 'app')).toBe(BigInt(1234))
    expect(q('egress_bytes', 's3')).toBe(BigInt(50))
    expect(q('db_bytes', 'pg')).toBe(BigInt(9000))
    expect(rows.every((r) => r.billingAccountId === userId)).toBe(true)

    // A later, smaller gauge sample the same day does not lower the maximum.
    l.record({ projectId: p, axis: 'db_bytes', quantity: 100, source: 'pg' })
    await l.flush()
    expect((await rowsFor(p)).find((r) => r.axis === 'db_bytes')?.quantity).toBe(BigInt(9000))
  })

  it('ignores malformed usage instead of throwing', () => {
    const l = ledger()
    expect(() => {
      l.record({ projectId: 'not-a-uuid', axis: 'egress_bytes', quantity: 1, source: 'app' })
      l.record({ projectId: randomUUID(), axis: 'nope' as any, quantity: 1, source: 'app' })
      l.record({ projectId: randomUUID(), axis: 'egress_bytes', quantity: -5, source: 'app' })
      l.record({ projectId: randomUUID(), axis: 'egress_bytes', quantity: 1, source: 'bogus' as any })
    }).not.toThrow()
    expect(l.pendingSize()).toBe(0)
  })

  it('does not bill usage whose project no longer exists and whose owner was never known', async () => {
    const ghost = randomUUID()
    const l = ledger()
    l.record({ projectId: ghost, axis: 'fn_runs', quantity: 3, source: 'executor' })
    await l.flush()
    expect(await rowsFor(ghost)).toHaveLength(0)
    expect(l.queuedBatches()).toBe(0)
  })

  it('attributes to the account the caller names, even after the project is gone', async () => {
    const { userId } = await makeOwnerWithProjects(0)
    const gone = randomUUID()
    createdProjects.push(gone)
    const l = ledger()
    l.record({ projectId: gone, axis: 'fn_runs', quantity: 2, source: 'executor', billingAccountId: userId })
    await l.flush()
    const rows = await rowsFor(gone)
    expect(rows).toHaveLength(1)
    expect(rows[0].billingAccountId).toBe(userId)
  })
})

// ============================================================================
// EXACTLY ONCE
// ============================================================================

describe('exactly once', () => {
  it('applies a batch once however many times it is delivered', async () => {
    const { projects: [p] } = await makeOwnerWithProjects(1)
    const batch: LedgerBatch = await track({
      id: `test-${randomUUID()}`,
      kind: 'flush',
      entries: [{ projectId: p, axis: 'fn_runs', day: new Date().toISOString().slice(0, 10), source: 'executor', quantity: BigInt(5), billingAccountId: null }],
    })
    expect((await applyUsageBatch(batch)).applied).toBe(true)
    expect((await applyUsageBatch(batch)).applied).toBe(false)
    expect((await applyUsageBatch(batch)).applied).toBe(false)
    expect((await rowsFor(p))[0].quantity).toBe(BigInt(5))
  })

  it('keeps a batch that failed to apply and applies it on the next flush', async () => {
    const { projects: [p] } = await makeOwnerWithProjects(1)
    let failNext = true
    const flaky = {
      $transaction: (fn: any, opts: any) => {
        if (failNext) {
          failNext = false
          return Promise.reject(new Error('connection reset'))
        }
        return prisma.$transaction(fn, opts)
      },
    }
    const l = ledger(tmpSpool(), flaky)
    l.record({ projectId: p, axis: 'fn_runs', quantity: 4, source: 'executor' })
    await expect(l.flush()).rejects.toThrow('connection reset')
    expect(l.queuedBatches()).toBe(1)
    expect(await rowsFor(p)).toHaveLength(0)

    await l.flush()
    expect(l.queuedBatches()).toBe(0)
    expect((await rowsFor(p))[0].quantity).toBe(BigInt(4))
  })

  it('does not double count when the commit landed but the caller saw a failure', async () => {
    const { projects: [p] } = await makeOwnerWithProjects(1)
    let ambiguous = true
    const lying = {
      $transaction: async (fn: any, opts: any) => {
        const r = await prisma.$transaction(fn, opts)
        if (ambiguous) {
          ambiguous = false
          throw new Error('socket closed after commit')
        }
        return r
      },
    }
    const l = ledger(tmpSpool(), lying)
    l.record({ projectId: p, axis: 'fn_runs', quantity: 7, source: 'executor' })
    await expect(l.flush()).rejects.toThrow('after commit')
    expect(l.queuedBatches()).toBe(1) // kept, because the caller cannot know

    await l.flush() // same batch id again
    expect(l.queuedBatches()).toBe(0)
    expect((await rowsFor(p))[0].quantity).toBe(BigInt(7))
  })
})

// ============================================================================
// SHUTDOWN
// ============================================================================

describe('shutdown', () => {
  it('spools synchronously, and a later ledger replays the spool exactly once', async () => {
    const { projects: [p] } = await makeOwnerWithProjects(1)
    const dir = tmpSpool()
    const dying = ledger(dir)
    dying.record({ projectId: p, axis: 'egress_bytes', quantity: 4096, source: 'app' })
    // The process exits right after the signal handler's synchronous spool.
    expect(dying.spoolSync()).toBe(1)
    const spooled = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(spooled).toHaveLength(1)
    const spooledId = spooled[0].slice(0, -'.json'.length)
    batchIds.push(spooledId)
    expect(await rowsFor(p)).toHaveLength(0)

    const next = ledger(dir)
    expect(next.loadSpool()).toBe(1)
    await next.flush()
    expect((await rowsFor(p))[0].quantity).toBe(BigInt(4096))
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0)

    // A spool file restored from a backup, or read by a second process, still
    // cannot count twice.
    const again = ledger(dir)
    fs.writeFileSync(path.join(dir, 'dup.json'), JSON.stringify({ id: spooledId, kind: 'spool', entries: [{ projectId: p, axis: 'egress_bytes', day: new Date().toISOString().slice(0, 10), source: 'app', quantity: '4096', billingAccountId: null }] }))
    again.loadSpool()
    await again.flush()
    expect((await rowsFor(p))[0].quantity).toBe(BigInt(4096))
  })

  it('leaves the spool in place when the database cannot be reached before exit', async () => {
    const { projects: [p] } = await makeOwnerWithProjects(1)
    const dir = tmpSpool()
    const down = { $transaction: () => Promise.reject(new Error('database unreachable')) }
    const l = ledger(dir, down)
    l.record({ projectId: p, axis: 'fn_runs', quantity: 9, source: 'executor' })
    await l.shutdown(500)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1)

    const recovered = ledger(dir)
    recovered.loadSpool()
    await recovered.flush()
    expect((await rowsFor(p))[0].quantity).toBe(BigInt(9))
  })
})

// ============================================================================
// THE MONTHLY CLOSE
// ============================================================================

describe('monthly close', () => {
  const PERIOD = '2019-04' // 30 days, long finished
  const AFTER = new Date(Date.UTC(2019, 4, 2))

  async function seed(projectId: string, account: string, axis: string, day: string, source: string, quantity: number) {
    await prisma.usageDaily.create({
      data: { billingAccountId: account, projectId, axis, day: new Date(`${day}T00:00:00Z`), source, quantity: BigInt(quantity) },
    })
  }

  it('pools an account across its projects and closes each axis once', async () => {
    const { userId, projects: [a, b] } = await makeOwnerWithProjects(2)
    // counters
    await seed(a, userId, 'egress_bytes', '2019-04-03', 'app', 1_000)
    await seed(b, userId, 'egress_bytes', '2019-04-20', 'app', 500)
    await seed(a, userId, 'egress_bytes', '2019-04-03', 's3', 250)
    await seed(a, userId, 'egress_bytes', '2019-04-03', 'alb', 999_999) // not a billed source by default
    await seed(a, userId, 'mau', '2019-04-01', 'auth', 3)
    await seed(b, userId, 'mau', '2019-04-15', 'auth', 2)
    await seed(a, userId, 'fn_runs', '2019-04-10', 'executor', 40)
    // gauges: A holds 6 GB for 10 days, B holds 5 GB for 30 days
    const GB = 1024 ** 3
    for (let d = 1; d <= 10; d++) await seed(a, userId, 'db_bytes', `2019-04-${String(d).padStart(2, '0')}`, 'pg', 6 * GB)
    for (let d = 1; d <= 30; d++) await seed(b, userId, 'db_bytes', `2019-04-${String(d).padStart(2, '0')}`, 'pg', 5 * GB)
    await prisma.userAiUsage.create({ data: { userId, date: PERIOD, tokenCount: 123_456 } })
    // outside the period: ignored
    await seed(a, userId, 'fn_runs', '2019-05-01', 'executor', 1_000)

    const first = await closePeriod(PERIOD, prisma, AFTER)
    expect(first.inserted).toBe(5)

    const closed = await prisma.usagePeriodClose.findMany({ where: { billingAccountId: userId, period: PERIOD } })
    const q = (axis: string) => closed.find((c) => c.axis === axis)?.quantity
    expect(q('egress_bytes')).toBe(BigInt(1_750)) // app 1500 + s3 250; alb excluded
    expect(q('mau')).toBe(BigInt(5))
    expect(q('fn_runs')).toBe(BigInt(40))
    // (6 GB x 10 + 5 GB x 30) / 30 days = 7 GB-months
    expect(q('db_bytes')).toBe(BigInt(7 * GB))
    expect(q('ai_tokens')).toBe(BigInt(123_456))

    // A second close, and new usage for the closed month, change nothing.
    await seed(b, userId, 'fn_runs', '2019-04-29', 'executor', 60)
    const second = await closePeriod(PERIOD, prisma, AFTER)
    expect(second.inserted).toBe(0)
    const after = await prisma.usagePeriodClose.findMany({ where: { billingAccountId: userId, period: PERIOD } })
    expect(after.map((c) => [c.axis, c.quantity.toString()]).sort()).toEqual(
      closed.map((c) => [c.axis, c.quantity.toString()]).sort(),
    )

    // What a live read would say now differs, which is exactly why billing
    // reads the close, never a live total.
    const live = await computePeriodTotals(PERIOD)
    expect(live.find((r) => r.billingAccountId === userId && r.axis === 'fn_runs')?.quantity).toBe(BigInt(100))
  })

  it('refuses to close a month that has not finished', async () => {
    const now = new Date()
    const current = now.toISOString().slice(0, 7)
    await expect(closePeriod(current, prisma, now)).rejects.toThrow(/has not finished/)
  })

  it('refuses to change a closed row', async () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'prisma/migrations-canonical/20260927180000_usage_ledger/migration.sql'),
      'utf8',
    )
    const fnSql = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf('CREATE TRIGGER'))
    // `prisma db push` builds test databases from the schema and knows nothing
    // of triggers, so install exactly what the migration installs.
    await prisma.$executeRawUnsafe(fnSql)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "usage_period_closes_no_update" ON "usage_period_closes"')
    await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('CREATE TRIGGER')))

    const { userId } = await makeOwnerWithProjects(0)
    await prisma.usagePeriodClose.create({
      data: { billingAccountId: userId, period: '2019-06', axis: 'fn_runs', quantity: BigInt(1), unit: 'runs' },
    })
    await expect(
      prisma.$executeRaw`UPDATE "usage_period_closes" SET "quantity" = 0 WHERE "billingAccountId" = ${userId}`,
    ).rejects.toThrow(/insert-only/)
  })
})

// ============================================================================
// WHO MAY WRITE USAGE
// ============================================================================

describe('authoritative usage is written only by the ledger and the close', () => {
  it('no route handler or client module writes the usage tables directly', () => {
    const { execSync } = require('child_process')
    let hits = ''
    try {
      hits = execSync(
      'git grep -nE "usageDaily\\.(create|update|upsert|delete)|usagePeriodClose\\.(create|update|upsert)|usage_daily|usage_period_closes" -- app components lib server packages ":!lib/usage/**"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
    } catch (err: any) {
      // git grep exits 1 when nothing matches: that is the passing case.
      if (err?.status !== 1) throw err
    }
    expect(hits).toBe('')
  })
})
