/**
 * The activity feeds say what Backenly did in words, never by an action's
 * machine name. Production QA (2026-11-16): a new project's feed read
 * "authority propose only" and "autonomy escalation retried", and an approved
 * index read "Applied your approved fix: slow query missing index".
 *
 * Each row below is written the way the loop, its approvals and its gate write
 * it. Both feeds are read: the Autonomy page's log (buildTrustReport) and the
 * project's activity feed (buildActivityFeed, which the shared change report
 * shows).
 */
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { buildTrustReport } from '@/lib/autonomy/trust-report'
import { buildActivityFeed } from '@/lib/activity/feed'
import { summariseFinding } from '@/lib/core/finding-summaries'

let userId: string
let projectId: string
let schema: string

const SLOW = { tableName: 'product_views', columnName: 'referrer', avgMs: 180 }
const SLOW_WORDS = summariseFinding('slow_query_missing_index', SLOW)
const FK = { tableName: 'reviews', columnName: 'user_id', referencedTable: 'users' }
const FK_WORDS = summariseFinding('missing_fk', FK)

/** Every row, as its writer writes it. */
function rows(slowFindingId: string, fkFindingId: string): Array<{ action: string; type: string; details: Record<string, unknown> }> {
  return [
    // lib/authority/gate.ts writeReceipt
    {
      action: 'AUTHORITY_PROPOSE_ONLY',
      type: 'autonomy',
      details: { actionClass: 'create_index', resource: `${schema}.product_views`, narrowedBy: ['storage_headroom'], reasons: ['The index would not fit in the storage the plan includes.'] },
    },
    { action: 'AUTHORITY_AUTO_EXECUTE', type: 'autonomy', details: { actionClass: 'create_index', resource: `${schema}.events`, narrowedBy: [], reasons: [] } },
    { action: 'AUTHORITY_FREEZE', type: 'autonomy', details: { actionClass: 'create_index', resource: `${schema}.events`, narrowedBy: ['sensor_unverified'], reasons: ['The sensor has not run.'] } },
    { action: 'AUTHORITY_LEGACY_COMPATIBILITY', type: 'autonomy', details: { findingType: 'realtime_gap', narrowedBy: ['action_class_unregistered'], outcome: 'permitted' } },
    // lib/autonomy/reconciler.ts
    {
      action: 'AUTONOMY_ESCALATION_RETRIED',
      type: 'autonomy',
      details: { findingId: slowFindingId, findingType: 'slow_query_missing_index', gapKey: 'k', tableName: 'product_views', attempt: 1, maxAttempts: 4, priorFailure: 'lock timeout' },
    },
    {
      action: 'AUTONOMY_RECURRENCE_ESCALATED',
      type: 'autonomy',
      details: { findingId: fkFindingId, findingType: 'missing_fk', gapKey: 'k2', tableName: 'reviews', priorAutoFixCount: 3, windowHours: 24 },
    },
    { action: 'AUTONOMY_RECURRENCE_SUPPRESSED', type: 'autonomy', details: { findingType: 'missing_fk', gapKey: 'k2', tableName: 'reviews', priorAutoFixCount: 1 } },
    { action: 'AUTONOMY_LOOP_STALLED', type: 'autonomy', details: { gapsFound: 2, skipped: { retry_backoff: 2 }, stalledReasons: ['retry_backoff'] } },
    { action: 'AUTONOMY_LIVE_RUN', type: 'autonomy', details: { attempted: 0, applied: 0 } },
    { action: 'AUTONOMY_TICK', type: 'autonomy', details: {} },
    { action: 'AUTONOMY_SUBSYSTEM_RECURRENCE_SHADOW', type: 'autonomy', details: {} },
    { action: 'AUTONOMY_SKIPPED', type: 'autonomy', details: { reason: 'REGION_UNREACHABLE', region: 'r1', pass: 'reconciler' } },
    { action: 'AUTONOMY_INVESTIGATION', type: 'autonomy', details: { findingId: fkFindingId, findingType: 'missing_fk', verdict: 'confirmed' } },
    { action: 'AUTONOMY_DIAGNOSIS_OUTCOME', type: 'autonomy', details: { findingId: fkFindingId, findingType: 'missing_fk', outcome: 'accepted' } },
    { action: 'AUTONOMY_CHANGE_FREEZE', type: 'autonomy', details: { reason: 'project is mid-incident', health: [], wouldHaveApplied: 2, loop: 'reconciler' } },
    { action: 'AUTONOMY_LEVEL_CHANGED', type: 'autonomy', details: { level: 'BALANCED' } },
    // lib/core/auto-fix-engine.ts
    {
      action: 'HEALTH_AUTO_FIXED',
      type: 'health',
      details: { findingId: randomUUID(), findingType: 'slow_query_missing_index', tableName: 'events', columnName: 'customer_id', verification: 'confirmed' },
    },
    { action: 'HEALTH_FIX_AWAITING_APPROVAL', type: 'health', details: { findingId: fkFindingId, findingType: 'missing_fk', reason: 'A foreign key changes which writes the database accepts.' } },
    { action: 'HEALTH_FIX_DEFERRED', type: 'health', details: { findingId: fkFindingId, findingType: 'missing_fk', deferReason: 'lock held' } },
    { action: 'HEALTH_FIX_CONFIRMED_LATE', type: 'health', details: { findingId: slowFindingId, findingType: 'slow_query_missing_index', note: 'An earlier fix could not be verified at the time.' } },
    { action: 'AUTHORITY_RECOVERY', type: 'health', details: { findingId: randomUUID(), findingType: 'missing_rls', tableName: 'orders', strategy: 'restore_policies', status: 'verified', message: 'Restored.' } },
    // app/api/projects/[id]/health/approve/route.ts
    { action: 'HEALTH_FIX_APPROVED', type: 'health', details: { findingId: slowFindingId, findingType: 'slow_query_missing_index' } },
    {
      action: 'HEALTH_FIX_EXECUTED',
      type: 'health',
      details: { findingId: slowFindingId, findingType: 'slow_query_missing_index', message: 'done', snapshotId: null, statements: [], verification: 'confirmed', regressionCheck: 'ran' },
    },
    { action: 'HEALTH_FIX_EXECUTION_FAILED', type: 'health', details: { findingId: fkFindingId, findingType: 'missing_fk', error: 'lock timeout' } },
    // lib/autonomy/ai-proposals.ts
    { action: 'AI_PROPOSAL_EXECUTED', type: 'health', details: { proposalId: 'p', findingId: fkFindingId, executionId: 'e', fixed: false } },
    // lib/autonomy/index-trials.ts
    { action: 'INDEX_TRIAL_RESULT', type: 'health', details: { outcome: 'kept', tableName: 'events', columnName: 'customer_id', sentence: 'Backenly kept the index it built on events (customer_id): queries filtering it got faster.' } },
    // lib/postgrest/supervisor.ts
    { action: 'DATA_PLANE_HEAL_VERIFIED', type: 'health', details: { region: 'r1', outcome: 'already_healthy', notes: [] } },
  ]
}

/** What a machine name looks like once a feed has lowercased it. */
function machineWords(action: string): string {
  return action.replace(/_/g, ' ').toLowerCase()
}

beforeAll(async () => {
  userId = (await prisma.user.create({
    data: { email: `words-${randomUUID().slice(0, 8)}@backenly.test`, name: 'words', password: 'not-a-real-hash' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'words', userId }, select: { id: true } })).id
  schema = `workspace_${projectId.replace(/-/g, '_')}`
  const slow = await prisma.healthFinding.create({
    data: { projectId, type: 'slow_query_missing_index', severity: 'warning', status: 'auto_fixed', autoFixed: true, fixAppliedAt: new Date(), details: SLOW },
    select: { id: true },
  })
  const fk = await prisma.healthFinding.create({
    data: { projectId, type: 'missing_fk', severity: 'warning', status: 'pending_approval', details: FK },
    select: { id: true },
  })
  const start = Date.now() - 60_000
  let i = 0
  for (const r of rows(slow.id, fk.id)) {
    await prisma.auditLog.create({
      data: { projectId, action: r.action, type: r.type, details: JSON.stringify(r.details), timestamp: new Date(start + 1000 * i++) },
    })
  }
})

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { projectId } })
  await prisma.healthFinding.deleteMany({ where: { projectId } })
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

const ACTIONS = () => rows('f', 'g').map((r) => r.action)
const FINDING_TYPES = ['slow_query_missing_index', 'missing_fk', 'missing_rls']

function expectWords(lines: string[]) {
  for (const line of lines) {
    for (const action of ACTIONS()) expect(line.toLowerCase()).not.toContain(machineWords(action))
    for (const type of FINDING_TYPES) expect(line.toLowerCase()).not.toContain(machineWords(type))
  }
}

describe("the Autonomy page's log", () => {
  let lines: string[]
  beforeAll(async () => {
    lines = (await buildTrustReport(projectId, 30)).recentActivity.map((a) => a.summary)
  })

  it('never shows an action or a finding type by its name', () => {
    expect(lines.length).toBeGreaterThan(0)
    expectWords(lines)
  })

  it('says what the gate held back, what the loop retried and what an approved fix did', () => {
    expect(lines).toContain('Held back a change to product_views for your approval')
    expect(lines).toContain(`Retried a fix that failed earlier (attempt 1 of 4): ${SLOW_WORDS}`)
    expect(lines).toContain(`Applied your approved fix: ${SLOW_WORDS} — re-checked and confirmed`)
    expect(lines).toContain(`Asked for your approval: ${FK_WORDS}`)
    expect(lines).toContain(`Could not apply your approved fix: ${FK_WORDS} — left for your review`)
    expect(lines).toContain('You set autonomy to Autopilot')
    expect(lines).toContain('Put the access rules on orders back after a repair failed its check')
    expect(lines.some((s) => s.startsWith('Backenly added an index on "events.customer_id" because'))).toBe(true)
  })

  it('leaves the loop’s own bookkeeping out', () => {
    // Ticks, deferrals, receipts the outcome row already tells, and the
    // operator's diagnostics: rows that change nothing and ask nothing.
    expect(lines.filter((s) => /tick|stalled|investigat|suppress|skipped|legacy|diagnos|proposal|data plane/i.test(s))).toEqual([])
  })
})

describe("the project's activity feed", () => {
  let labels: string[]
  beforeAll(async () => {
    labels = (await buildActivityFeed(projectId, { limit: 100 })).rows.map((r) => r.label)
  })

  it('never shows an action or a finding type by its name', () => {
    expect(labels.length).toBeGreaterThan(0)
    expectWords(labels)
  })

  it('says the same thing the Autonomy page says', () => {
    expect(labels).toContain('Held back a change to product_views for your approval')
    expect(labels).toContain(`Applied your approved fix: ${SLOW_WORDS} — re-checked and confirmed`)
    expect(labels).toContain('Backenly kept the index it built on events (customer_id): queries filtering it got faster.')
  })
})
