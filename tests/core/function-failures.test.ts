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

/**
 * Code that reads a variable Backenly no longer gives functions fails on every
 * call, which is certain before anyone calls it: a phone sign-in that signs its
 * own session with process.env.JWT_SECRET is refused the moment it runs. Such
 * code cannot be deployed any more, so this is code stored before, and its
 * owner is told from the code itself.
 */
describe('a function whose code reads a variable functions no longer get', () => {
  let withheldProject: string
  const ids: Record<string, string> = {}
  const route = (body: string) => `
    import { NextResponse } from 'next/server'
    import jwt from 'jsonwebtoken'
    export async function POST(request) {
      ${body}
    }
  `
  async function stored(name: string, code: string, status = 'active') {
    ids[name] = (await prisma.aiFunction.create({
      data: { projectId: withheldProject, name, description: name, generatedCode: code, codeOrigin: 'agent', triggerType: 'http', status },
    })).id
  }
  const reported = async () =>
    Object.fromEntries((await detectFailingFunctions(withheldProject)).map((f) => [f.details.functionName, f]))

  beforeAll(async () => {
    withheldProject = (await prisma.project.create({ data: { name: 'fn-failures-withheld', userId } })).id
    await stored('phone-verify', route(`
      const { userId } = await request.json()
      return NextResponse.json({ token: jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' }) })`))
    await stored('admin-report', route(`
      if (request.headers.get('x-admin-key') !== process.env.ADMIN_API_KEY) return NextResponse.json({}, { status: 403 })
      return NextResponse.json({ ok: true })`))
    // Names it only in a comment, and signs with a secret of its own.
    await stored('own-secret', route(`
      // used to sign with process.env.JWT_SECRET
      return NextResponse.json({ token: jwt.sign({ a: 1 }, process.env.MY_SIGNING_KEY) })`))
    await stored('switched-off', route(`return NextResponse.json({ s: process.env.JWT_SECRET })`), 'inactive')
    // Reads it and has already failed on real calls: reported once, from its runs.
    await stored('busy-verify', route(`return NextResponse.json({ s: jwt.sign({}, process.env.JWT_SECRET) })`))
    await runs(ids['busy-verify'], [
      { ok: false, at: hoursAgo(3), error: "Functions cannot sign the project's end-user sessions" },
      { ok: false, at: hoursAgo(2), error: "Functions cannot sign the project's end-user sessions" },
      { ok: false, at: hoursAgo(1), error: "Functions cannot sign the project's end-user sessions" },
    ], withheldProject)
  }, 60_000)

  afterAll(async () => {
    await prisma.aiFunctionLog.deleteMany({ where: { projectId: withheldProject } })
    await prisma.aiFunction.deleteMany({ where: { projectId: withheldProject } })
    await prisma.project.delete({ where: { id: withheldProject } })
  })

  test('is reported before any run, once per function, and only while its code reads the variable', async () => {
    const byName = await reported()
    expect(Object.keys(byName).sort()).toEqual(['admin-report', 'busy-verify', 'phone-verify'])
    expect(byName['phone-verify']).toMatchObject({
      type: 'function_failing',
      severity: 'warning',
      autoFixable: false,
      details: { functionId: ids['phone-verify'], trigger: 'http', reason: 'reads_withheld_variable', variable: 'JWT_SECRET' },
    })
    expect(byName['admin-report'].details).toMatchObject({ reason: 'reads_withheld_variable', variable: 'ADMIN_API_KEY' })
    // Its runs already show it: one row, from the runs, critical.
    expect(byName['busy-verify']).toMatchObject({ severity: 'critical', details: { runs: 3, failures: 3 } })
    expect(byName['busy-verify'].details).not.toHaveProperty('reason')
  })

  test('clears once its owner deploys code that no longer reads it', async () => {
    await prisma.aiFunction.update({
      where: { id: ids['phone-verify'] },
      data: {
        generatedCode: `
          import { NextResponse } from 'next/server'
          import { createSession } from '@/lib/auth/session'
          export async function POST(request) {
            const { userId } = await request.json()
            return NextResponse.json(await createSession(userId))
          }
        `,
      },
    })
    expect(Object.keys(await reported()).sort()).toEqual(['admin-report', 'busy-verify'])
  })

  test('tells the owner what to use instead', () => {
    const phone = { functionName: 'phone-verify', trigger: 'http', reason: 'reads_withheld_variable', variable: 'JWT_SECRET' }
    expect(summariseFinding('function_failing', phone)).toBe(
      '`phone-verify` reads JWT_SECRET, which functions no longer get, so every call fails',
    )
    expect(getManualRemediationHint('function_failing', phone)).toBe(
      'phone-verify answers HTTP requests, and its code reads process.env.JWT_SECRET, which Backenly no longer gives ' +
        'function code, so every call to it fails.' +
        "\n\nTo sign a user in once the function has proved who they are, it calls createSession(userId) from " +
        "'@backenly/functions', which returns the session Backenly signs. To check a caller's session, it calls " +
        'verifyToken(token) from the same module.' +
        '\n\nAsk your coding agent to change phone-verify that way and deploy it again. This clears once its code ' +
        'no longer reads JWT_SECRET.',
    )
    const admin = { ...phone, functionName: 'admin-report', variable: 'ADMIN_API_KEY' }
    expect(getManualRemediationHint('function_failing', admin)).toContain(
      "To admit only the project's admin key, it calls isAdminRequest(request) from '@backenly/functions'",
    )
  })
})
