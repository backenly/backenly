/**
 * FUNCTIONS THAT KEEP FAILING — the loop reads the run log
 * ----------------------------------------------------------
 * Production QA (2026-11-09): a function a coding agent deployed on order
 * updates failed on every real update for two hours, while the loop reported
 * "27 guarantees checked, 0 broken". Nothing read the run log.
 *
 * Same contract as the probe fixtures: build the failing state for real, assert
 * the probe fires, then assert it goes quiet once the function works again.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { detectFailingFunctions, FAILING_MIN_FAILURES } from '@/lib/autonomy/function-failures'
import { INVARIANTS } from '@/lib/autonomy/desired-state'
import { classifyFix } from '@/lib/core/fix-classifier'
import { getManualRemediationHint } from '@/lib/core/fix-actions'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { categoryOf } from '@/lib/core/finding-groups'

let userId: string
let projectId: string
let neighbourId: string
const fns: Record<string, string> = {}
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000)

async function fn(name: string, opts: { triggerType?: string; triggerTable?: string; status?: string; project?: string } = {}) {
  const row = await prisma.aiFunction.create({
    data: {
      projectId: opts.project ?? projectId,
      name,
      description: `${name} (test)`,
      generatedCode: 'return null',
      codeOrigin: 'agent',
      triggerType: opts.triggerType ?? 'on_db_update',
      triggerTable: opts.triggerTable ?? 'orders',
      status: opts.status ?? 'active',
    },
  })
  fns[name] = row.id
  return row.id
}

async function runs(functionId: string, list: Array<{ ok: boolean; at: Date; error?: string }>, project = projectId) {
  await prisma.aiFunctionLog.createMany({
    data: list.map((r) => ({
      functionId,
      projectId: project,
      success: r.ok,
      logs: [],
      error: r.ok ? null : (r.error ?? 'TypeError: Cannot read properties of undefined'),
      durationMs: 12,
      triggerType: 'on_db_update',
      createdAt: r.at,
    })),
  })
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `fn-failures-${Date.now()}@example.test`, password: 'x', name: 'fn' } })
  userId = user.id
  projectId = (await prisma.project.create({ data: { name: 'fn-failures', userId } })).id
  neighbourId = (await prisma.project.create({ data: { name: 'fn-failures-neighbour', userId } })).id

  // Fails on most real updates, the latest included.
  await runs(await fn('notify_shipping'), [
    { ok: true, at: hoursAgo(5) },
    { ok: false, at: hoursAgo(4) },
    { ok: false, at: hoursAgo(3) },
    { ok: false, at: hoursAgo(2), error: 'TypeError: Cannot read properties of undefined (reading \'email\')\n    at handler (fn.js:3:20)' },
  ])
  // Fails on every run.
  await runs(await fn('award_points', { triggerType: 'on_signup', triggerTable: undefined }), [
    { ok: false, at: hoursAgo(6) },
    { ok: false, at: hoursAgo(4) },
    { ok: false, at: hoursAgo(1) },
  ])
  // Failed, then was fixed: its latest run succeeded.
  await runs(await fn('recount_stock'), [
    { ok: false, at: hoursAgo(6) },
    { ok: false, at: hoursAgo(5) },
    { ok: false, at: hoursAgo(4) },
    { ok: true, at: hoursAgo(1) },
  ])
  // Failed twice: not yet a pattern.
  await runs(await fn('tag_vip'), [
    { ok: false, at: hoursAgo(3) },
    { ok: false, at: hoursAgo(2) },
  ])
  // Switched off by its owner after failing.
  await runs(await fn('old_digest', { status: 'inactive' }), [
    { ok: false, at: hoursAgo(5) },
    { ok: false, at: hoursAgo(4) },
    { ok: false, at: hoursAgo(3) },
  ])
  // Failed, but more than a day ago.
  await runs(await fn('weekly_report', { triggerType: 'cron', triggerTable: '0 9 * * 1' }), [
    { ok: false, at: hoursAgo(30) },
    { ok: false, at: hoursAgo(29) },
    { ok: false, at: hoursAgo(28) },
  ])
  // Another project's failing function.
  await runs(await fn('elsewhere', { project: neighbourId }), [
    { ok: false, at: hoursAgo(3) },
    { ok: false, at: hoursAgo(2) },
    { ok: false, at: hoursAgo(1) },
  ], neighbourId)
}, 60_000)

afterAll(async () => {
  await prisma.aiFunctionLog.deleteMany({ where: { projectId: { in: [projectId, neighbourId] } } })
  await prisma.aiFunction.deleteMany({ where: { projectId: { in: [projectId, neighbourId] } } })
  await prisma.project.deleteMany({ where: { id: { in: [projectId, neighbourId] } } })
  await prisma.user.delete({ where: { id: userId } })
})

describe('detectFailingFunctions', () => {
  test('reports the functions still failing, and only those', async () => {
    const findings = await detectFailingFunctions(projectId)
    const byName = Object.fromEntries(findings.map((f) => [f.details.functionName, f]))
    expect(Object.keys(byName).sort()).toEqual(['award_points', 'notify_shipping'])

    expect(byName.notify_shipping).toMatchObject({
      type: 'function_failing',
      severity: 'warning',
      autoFixable: false,
      details: {
        functionId: fns.notify_shipping,
        trigger: 'on_db_update',
        tableName: 'orders',
        runs: 4,
        failures: 3,
        lastError: "TypeError: Cannot read properties of undefined (reading 'email')",
        windowHours: 24,
      },
    })
    // Every run failed: whatever it does is not happening.
    expect(byName.award_points).toMatchObject({ severity: 'critical', details: { runs: 3, failures: 3, trigger: 'on_signup' } })
    expect(byName.award_points.details).not.toHaveProperty('tableName')
  })

  test('goes quiet once the function runs successfully', async () => {
    await runs(fns.notify_shipping, [{ ok: true, at: new Date() }])
    const findings = await detectFailingFunctions(projectId)
    expect(findings.map((f) => f.details.functionName)).toEqual(['award_points'])
  })

  test('needs at least three failures', () => {
    expect(FAILING_MIN_FAILURES).toBe(3)
  })
})

describe('what a person reads', () => {
  const finding = {
    type: 'function_failing',
    details: {
      functionId: 'f1',
      functionName: 'notify_shipping',
      trigger: 'on_db_update',
      tableName: 'orders',
      runs: 4,
      failures: 3,
      lastError: "TypeError: Cannot read properties of undefined (reading 'email')",
      windowHours: 24,
    },
  }

  test('a guarantee holds it, and the loop only tells', () => {
    expect(INVARIANTS.find((i) => i.id === 'functions_keep_working')?.probe).toBe(detectFailingFunctions)
    expect(classifyFix('function_failing', finding.details).decision).toBe('notify_only')
    expect(categoryOf(finding)).toBe('reliability')
  })

  test('says which function, how often, the error and what to do', () => {
    expect(summariseFinding('function_failing', finding.details)).toBe('`notify_shipping` failed 3 of its last 4 runs')
    expect(getManualRemediationHint('function_failing', finding.details)).toBe(
      'notify_shipping runs when a row in orders changes, and it failed 3 of its 4 runs in the last 24 hours, ' +
        "the latest one included.\n\nThe last failure: TypeError: Cannot read properties of undefined (reading 'email')" +
        '\n\nAsk your coding agent to fix notify_shipping and deploy it again. Its runs are on the Functions page, ' +
        'and this clears once a run succeeds.',
    )
  })
})
