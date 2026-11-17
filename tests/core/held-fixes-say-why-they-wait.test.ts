/**
 * A fix Backenly would apply on its own, held for a person, says why
 * ------------------------------------------------------------------
 * The authority decision (lib/authority/decision.ts) can hold an automatic
 * repair for a person: a build too large for the account's storage, a table
 * someone else is changing, a deployment that applies nothing. The Review Queue
 * card said none of it. Production QA (2026-11-16): a slow-query index whose
 * finding said "Adding the index changes no data and is reversible" waited in
 * Autopilot under "Waiting on you" with no reason given.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { runAutoFix } from '@/lib/core/auto-fix-engine'
import { authorityHoldWords, buildTrustReport } from '@/lib/autonomy/trust-report'
import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'

let userId: string
let projectId: string
let findingId: string
const saved = {
  reconciler: process.env.ENABLE_AUTONOMY_RECONCILER,
  live: process.env.ENABLE_AUTONOMY_LIVE_EXECUTION,
}

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `held-${Date.now()}@example.test`, password: 'x', name: 'held' } })).id
  projectId = (await prisma.project.create({ data: { name: 'held', userId, autonomyLevel: 'AGGRESSIVE' } as any })).id
  const schema = `workspace_${projectId}`
  await queryWorkspaceSchema(projectId, `CREATE SCHEMA "${schema}"`)
  await queryWorkspaceSchema(projectId, `CREATE TABLE "${schema}".product_views (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referrer text)`)
  findingId = (await prisma.healthFinding.create({
    data: {
      projectId,
      type: 'slow_query_missing_index',
      severity: 'warning',
      status: 'open',
      autoFixed: false,
      details: {
        reason: 'Queries filtering "product_views"."referrer" are averaging 180ms across 40 calls, and that column has no index. Adding the index changes no data and is reversible.',
        location: 'product_views.referrer',
        tableName: 'product_views',
        columnName: 'referrer',
        avgMs: 180,
        calls: 40,
        source: 'pg_stat_statements',
      },
    },
  })).id
  // The loop runs here, and this deployment applies nothing: the decision holds
  // the repair for a person, which is the hold under test.
  process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
  process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'false'
}, 60_000)

afterAll(async () => {
  process.env.ENABLE_AUTONOMY_RECONCILER = saved.reconciler
  process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = saved.live
  if (saved.reconciler === undefined) delete process.env.ENABLE_AUTONOMY_RECONCILER
  if (saved.live === undefined) delete process.env.ENABLE_AUTONOMY_LIVE_EXECUTION
  await queryWorkspaceSchema(projectId, `DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.projectPreference.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('a held automatic repair', () => {
  test('is held, and keeps what held it on the finding', async () => {
    const res = await runAutoFix(findingId, projectId, { actor: { kind: 'autonomous', loop: 'reconciler' } })
    expect(res.outcome).toBe('pending_approval')
    const finding = await prisma.healthFinding.findUnique({ where: { id: findingId } })
    expect(finding?.status).toBe('pending_approval')
    const held = (finding?.details as any)?.heldByAuthority
    expect(held.narrowings.map((n: { code: string }) => n.code)).toContain('deployment_deployment_flag_off')
  }, 120_000)

  test('says on its card why it waits', async () => {
    const report = await buildTrustReport(projectId, 30)
    const card = report.pendingApprovals.find((p) => p.id === findingId)
    expect(card?.heldBecause).toEqual({
      kind: 'guardrail',
      text: expect.stringMatching(/has not enabled live execution/),
    })
  })
})

describe('the words for what held it', () => {
  test('are the decision\'s own sentence when it is written for the owner', () => {
    const storage = 'This would take about 228 MB, bringing the account to 99% of the 512 MB of database storage its plan includes. Backenly leaves the last 10% to you.'
    expect(authorityHoldWords([{ code: 'sensor_unverified', reason: 'Probe x ran quietly but has never fired' }, { code: 'storage_headroom', reason: storage }])).toBe(storage)
  })

  test('are plain, never a probe id or a tier, when it is not', () => {
    const words = authorityHoldWords([{ code: 'sensor_unverified', reason: 'Probe measured_slow_queries_are_indexed ran quietly but has never fired' }])
    expect(words).toMatch(/has not yet been seen working on this project/)
    expect(words).not.toMatch(/measured_slow_queries_are_indexed|probe/i)
    expect(authorityHoldWords([{ code: 'tier_above_ceiling_no_grant', reason: 'create_index is tier 2' }])).toBe('Your autonomy mode keeps this kind of change for you.')
  })

  test('are nothing when nothing held it', () => {
    expect(authorityHoldWords([])).toBeNull()
  })
})
