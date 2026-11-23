/**
 * A TRANSACTION WAITS FOR A CONNECTION AS A QUERY DOES, AND THE FLEET PASSES
 * DO NOT ALL START IN THE SAME SECOND
 * ===========================================================================
 * Every Prisma client this server opens has a small pool. The scheduler's fleet
 * passes used to start together at :00, :10 and :20 and hold those pools for a
 * few seconds; a query arriving then waited its turn, but an interactive
 * transaction gave up after Prisma's 2 s default ("Unable to start a
 * transaction in the given time"): end users' sign-ups and sign-ins, the usage
 * ledger's flush, the daily graph cleanup. These hold both halves of the fix to
 * the code: every client is given the 10 s wait (lib/db/transaction-defaults.ts),
 * and the hourly and ten-minute passes start on minutes of their own.
 */

import fs from 'fs'
import path from 'path'

import { TRANSACTION_MAX_WAIT_MS, transactionDefaults } from '@/lib/db/transaction-defaults'
import { matchesCronExpression } from '@/lib/services/cron-expression'

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

describe('the transaction wait', () => {
  it('is as long as a query waits for a connection (Prisma pool_timeout, 10 s), not 2 s', () => {
    expect(TRANSACTION_MAX_WAIT_MS).toBe(10_000)
    expect(transactionDefaults()).toEqual({ maxWait: 10_000 })
  })

  it('is a fresh object each time, so no client can change another’s', () => {
    const a = transactionDefaults()
    a.maxWait = 1
    expect(transactionDefaults().maxWait).toBe(10_000)
  })

  it.each(['lib/db/postgres.ts', 'lib/data-plane/regional.ts'])('is given to every Prisma client %s opens', (file) => {
    const code = read(file)
    const clients = [...code.matchAll(/new PrismaClient\(\{([\s\S]*?)\}\)/g)].map((m) => m[1])
    expect(clients.length).toBeGreaterThan(0)
    expect(clients.filter((options) => !/transactionOptions: transactionDefaults\(\)/.test(options))).toEqual([])
  })

  it('opens the platform, workspace, data instance and project database clients with it', () => {
    expect(read('lib/data-plane/regional.ts').match(/transactionOptions: transactionDefaults\(\)/g)).toHaveLength(3)
    expect(read('lib/db/postgres.ts')).toMatch(/transactionOptions: transactionDefaults\(\)/)
  })
})

describe('the scheduler’s fleet passes (instrumentation.ts)', () => {
  // Line comments first, as tests/unit/scheduler-per-region.spec.ts does.
  const code = read('instrumentation.ts')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  /** Each job with a five-field expression: the expression and the code up to the next job. */
  const jobs = (() => {
    const starts = [...code.matchAll(/cron\.(?:schedule|platform)\('([^']+)'/g)].map((m) => ({ index: m.index ?? 0, expr: m[1] }))
    return starts.map((s, i) => ({ expr: s.expr, text: code.slice(s.index, starts[i + 1]?.index ?? code.length) }))
  })()

  /** The minutes of an hour an expression fires on, read with the matcher user jobs use. */
  function minutesOf(expr: string): number[] {
    const out: number[] = []
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        if (matchesCronExpression(expr, new Date(Date.UTC(2026, 10, 23, hour, minute))) && !out.includes(minute)) out.push(minute)
      }
    }
    return out.sort((a, b) => a - b)
  }

  function exprOf(fn: string): string {
    const found = jobs.filter((job) => job.text.includes(fn))
    expect(found).toHaveLength(1)
    return found[0].expr
  }

  // Each of these takes connections for every project it serves.
  const FLEET_PASSES = [
    'diagnoseEscalatedFindings',
    'sweepProjectMaintenance',
    'sweepArchitecture',
    'snapshotScheduledDbStorage',
    'ingestConfiguredLogs',
    'collectBaseline',
    'reconcileScheduledFileStorage',
    'runDriftEventUpkeep',
  ]

  it('keeps each pass’s cadence', () => {
    expect(minutesOf(exprOf('diagnoseEscalatedFindings'))).toHaveLength(6)
    expect(minutesOf(exprOf('sweepProjectMaintenance'))).toHaveLength(6)
    expect(minutesOf(exprOf('sweepArchitecture'))).toHaveLength(6)
    expect(minutesOf(exprOf('ingestConfiguredLogs'))).toHaveLength(4)
    expect(minutesOf(exprOf('snapshotScheduledDbStorage'))).toHaveLength(1)
  })

  it('starts no two of them on the same minute', () => {
    const taken = new Map<number, string>()
    const clashes: string[] = []
    for (const fn of FLEET_PASSES) {
      for (const minute of minutesOf(exprOf(fn))) {
        if (taken.has(minute)) clashes.push(`:${minute} ${taken.get(minute)} and ${fn}`)
        taken.set(minute, fn)
      }
    }
    expect(clashes).toEqual([])
  })

  it('starts none of them on a minute an hourly or daily job starts on', () => {
    // Every other job with a fixed minute (the daily passes, the platform's hourly work).
    const fixed = jobs
      .filter((job) => /^\d+ /.test(job.expr) && !FLEET_PASSES.some((fn) => job.text.includes(fn)))
      .map((job) => Number(job.expr.split(' ')[0]))
    expect(fixed.length).toBeGreaterThan(5)
    const clashes = FLEET_PASSES.flatMap((fn) => minutesOf(exprOf(fn)).filter((m) => fixed.includes(m)).map((m) => `${fn} at :${m}`))
    expect(clashes).toEqual([])
  })
})
