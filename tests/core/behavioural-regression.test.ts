/**
 * BEHAVIOURAL REGRESSION — the query got slower, and here is what changed
 * ------------------------------------------------------------------------
 * The gap this closes: every performance check in the platform compared against
 * a fixed number, so a query that went from 4ms to 60ms was invisible — still
 * fast by any threshold, fifteen times worse than it was, and almost always the
 * thing the developer actually noticed.
 *
 * Two things are proven here against a real database:
 *
 *   1. a subject that deviates from its own recorded history becomes a finding,
 *      and one that has no history yet does not
 *   2. the finding carries what changed on this backend beforehand — the thing
 *      the developer was about to go and look up by hand — worded as adjacency
 *      rather than causation
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { detectBehaviouralRegression, THRESHOLDS } from '@/lib/autonomy/baseline/detect'
import { hourBucket, queryFingerprint } from '@/lib/autonomy/baseline/collector'
import { MIN_BASELINE_SAMPLES } from '@/lib/autonomy/baseline/deviation'
import { changesBefore, summariseCorrelation } from '@/lib/autonomy/change-correlation'
import { classifyFix } from '@/lib/core/fix-classifier'
import { deriveTier, INVARIANTS } from '@/lib/autonomy/desired-state'
import { buildFixAction, getManualRemediationHint } from '@/lib/core/fix-actions'

let userId: string
let projectId: string

/** The hour the probe judges: the most recent COMPLETE one. */
const judgedBucket = () => new Date(hourBucket().getTime() - 60 * 60 * 1000)

const FP = queryFingerprint('SELECT id FROM "orders" WHERE "customer_ref" = $1')

/** Seed `hours` of history ending just before the judged bucket. */
const seedHistory = async (
  kind: string,
  subject: string,
  value: number,
  hours: number,
  metadata?: Record<string, unknown>,
) => {
  const base = judgedBucket().getTime()
  for (let i = hours; i >= 1; i--) {
    await prisma.dbBaselineSample.create({
      data: {
        projectId, kind, subject,
        bucket: new Date(base - i * 60 * 60 * 1000),
        value, samples: 100, metadata: metadata as any,
      },
    })
  }
}

const seedCurrent = async (
  kind: string,
  subject: string,
  value: number,
  metadata?: Record<string, unknown>,
) => {
  await prisma.dbBaselineSample.create({
    data: {
      projectId, kind, subject, bucket: judgedBucket(),
      value, samples: 100, metadata: metadata as any,
    },
  })
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `behav-${Date.now()}@example.test`, password: 'x', name: 'behav' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'behavioural-test', userId } })
  projectId = project.id
}, 60_000)

afterAll(async () => {
  await prisma.dbBaselineSample.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('the loop runs this check', () => {
  test('it is registered in the invariant catalogue', () => {
    const inv = INVARIANTS.find(i => i.id === 'the_backend_behaves_like_itself')
    expect(inv).toBeDefined()
    expect(inv!.probe).toBe(detectBehaviouralRegression)
  })
})

describe('a query that got slower than its own normal', () => {
  test('says nothing with no history at all', async () => {
    await seedCurrent('query', FP, 60, { sql: 'SELECT id FROM "orders" WHERE "customer_ref" = $1' })
    expect(await detectBehaviouralRegression(projectId)).toEqual([])
    await prisma.dbBaselineSample.deleteMany({ where: { projectId } })
  }, 60_000)

  test('says nothing with too little history, however large the jump', async () => {
    await seedHistory('query', FP, 4, 4, { sql: 'SELECT …' })
    await seedCurrent('query', FP, 600, { sql: 'SELECT …' })
    expect(await detectBehaviouralRegression(projectId)).toEqual([])
    await prisma.dbBaselineSample.deleteMany({ where: { projectId } })
  }, 60_000)

  test('reports the deviation once there is a real baseline', async () => {
    const sql = 'SELECT id FROM "orders" WHERE "customer_ref" = $1'
    await seedHistory('query', FP, 4, MIN_BASELINE_SAMPLES + 6, { sql })
    await seedCurrent('query', FP, 60, { sql })

    const findings = await detectBehaviouralRegression(projectId)
    expect(findings).toHaveLength(1)
    const d = findings[0].details as any
    expect(d.measure).toBe('query_latency')
    expect(d.baselineValue).toBe(4)
    expect(d.currentValue).toBe(60)
    expect(d.ratio).toBe(15)
    // The statement itself, so the finding names a query rather than a hash.
    expect(d.sql).toContain('customer_ref')
    // 15x is 5x the threshold — well past the critical multiplier.
    expect(findings[0].severity).toBe('critical')
    expect(d.reason).toContain('15.0×')
  }, 60_000)

  test('a query still inside its normal range is not reported', async () => {
    await prisma.dbBaselineSample.deleteMany({ where: { projectId } })
    await seedHistory('query', FP, 40, MIN_BASELINE_SAMPLES + 6, { sql: 'SELECT …' })
    // Under the ratio threshold.
    await seedCurrent('query', FP, 40 * (THRESHOLDS.latencyRatio - 0.5), { sql: 'SELECT …' })
    expect(await detectBehaviouralRegression(projectId)).toEqual([])
    await prisma.dbBaselineSample.deleteMany({ where: { projectId } })
  }, 60_000)

  test('a tiny query that multiplied is below the floor and stays quiet', async () => {
    await seedHistory('query', FP, 0.3, MIN_BASELINE_SAMPLES + 6, { sql: 'SELECT …' })
    await seedCurrent('query', FP, 9, { sql: 'SELECT …' })
    expect(await detectBehaviouralRegression(projectId)).toEqual([])
    await prisma.dbBaselineSample.deleteMany({ where: { projectId } })
  }, 60_000)
})

describe('table growth and scan rate', () => {
  test('unexpected growth is reported in bytes', async () => {
    await seedHistory('table', 'events:bytes', 300 * 1024 * 1024, MIN_BASELINE_SAMPLES + 6, { table: 'events' })
    await seedCurrent('table', 'events:bytes', 4 * 1024 * 1024 * 1024, { table: 'events' })

    const findings = await detectBehaviouralRegression(projectId)
    const growth = findings.find(f => (f.details as any).measure === 'table_size')
    expect(growth).toBeDefined()
    expect((growth!.details as any).tableName).toBe('events')
    expect((growth!.details as any).reason).toMatch(/writer that lost its bound/i)
    await prisma.dbBaselineSample.deleteMany({ where: { projectId } })
  }, 60_000)

  test('a jump in sequential scans is reported as its own measure', async () => {
    await seedHistory('table', 'events:seq_scan', 800, MIN_BASELINE_SAMPLES + 6, { table: 'events' })
    await seedCurrent('table', 'events:seq_scan', 9000, { table: 'events' })

    const findings = await detectBehaviouralRegression(projectId)
    const scans = findings.find(f => (f.details as any).measure === 'sequential_scans')
    expect(scans).toBeDefined()
    expect((scans!.details as any).reason).toMatch(/stopped using an index/i)
    await prisma.dbBaselineSample.deleteMany({ where: { projectId } })
  }, 60_000)
})

describe('what changed beforehand', () => {
  test('the finding carries the preceding changes, worded as adjacency', async () => {
    // A real change on the ledger, 30 minutes before the judged hour.
    await prisma.auditLog.create({
      data: {
        projectId,
        action: 'HEALTH_AUTO_FIXED',
        type: 'health',
        details: JSON.stringify({ findingType: 'missing_fk_index', tableName: 'orders' }),
        timestamp: new Date(judgedBucket().getTime() - 30 * 60 * 1000),
      },
    })

    const sql = 'SELECT id FROM "orders" WHERE "customer_ref" = $1'
    await seedHistory('query', FP, 4, MIN_BASELINE_SAMPLES + 6, { sql })
    await seedCurrent('query', FP, 60, { sql })

    const findings = await detectBehaviouralRegression(projectId)
    expect(findings).toHaveLength(1)
    const d = findings[0].details as any

    expect(d.changesBefore).toHaveLength(1)
    expect(d.changesBefore[0].source).toBe('autonomy')
    expect(d.changesBefore[0].minutesBefore).toBe(30)
    expect(d.changesBefore[0].summary).toContain('orders')

    // The wording is the point. Adjacency is a fact; causation would be a guess
    // dressed as a finding, and the first time it was wrong the owner would stop
    // trusting every other number on the page.
    expect(d.reason).toMatch(/not claiming any of them caused it/i)
    expect(d.reason).not.toMatch(/caused by|because of this deploy/i)

    await prisma.auditLog.deleteMany({ where: { projectId } })
    await prisma.dbBaselineSample.deleteMany({ where: { projectId } })
  }, 60_000)

  test('bookkeeping rows are not reported as changes', async () => {
    // A tick marker is written every minute and changes nothing. Listing it
    // beside a regression would bury the one row that matters.
    await prisma.auditLog.create({
      data: {
        projectId, action: 'AUTONOMY_TICK', type: 'autonomy',
        details: '{}', timestamp: new Date(Date.now() - 10 * 60 * 1000),
      },
    })
    expect(await changesBefore(projectId)).toEqual([])
    await prisma.auditLog.deleteMany({ where: { projectId } })
  }, 30_000)

  test('nothing preceding is said plainly rather than left blank', async () => {
    expect(summariseCorrelation([])).toBeNull()

    const sql = 'SELECT …'
    await seedHistory('query', FP, 4, MIN_BASELINE_SAMPLES + 6, { sql })
    await seedCurrent('query', FP, 60, { sql })
    const findings = await detectBehaviouralRegression(projectId)
    expect((findings[0].details as any).reason).toMatch(/Nothing changed on this backend beforehand/i)
    await prisma.dbBaselineSample.deleteMany({ where: { projectId } })
  }, 60_000)
})

describe('routing', () => {
  const details = {
    measure: 'query_latency',
    ratio: 15,
    observedHours: 18,
    sql: 'SELECT id FROM "orders" WHERE "customer_ref" = $1',
    changesBefore: [{ summary: 'Backenly missing fk index repaired on "orders"', minutesBefore: 30 }],
  }

  test('never auto-fixed — a symptom whose cause is not in the measurement', () => {
    expect(classifyFix('behavioural_regression', details).decision).toBe('notify_only')
    expect(deriveTier('behavioural_regression', details)).toBe(3)
    expect(buildFixAction('behavioural_regression', details)).toBeNull()
  })

  test('the hint hands over the numbers, the statement and the changes', () => {
    const hint = getManualRemediationHint('behavioural_regression', details)!
    expect(hint).toContain('15x')
    expect(hint).toContain('customer_ref')
    expect(hint).toContain('30 min before')
    expect(hint).toMatch(/not claiming any of these caused it/i)
  })
})
