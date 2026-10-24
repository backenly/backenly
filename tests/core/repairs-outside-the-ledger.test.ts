/**
 * REPAIRS OUTSIDE THE CHANGE LEDGER WAIT FOR A PERSON
 * ===================================================
 *
 * Four repair actions run outside the governed change ledger: FIX_API,
 * FIX_WORKFLOW, ADOPT_EXTERNAL_SCHEMA and REGISTER_SCHEMA. History cannot undo
 * any of them, so the autonomous loop never applies one on its own: it parks
 * the finding in the Review Queue, and the repair runs when a person approves
 * it. Every other autonomous repair still applies itself.
 *
 * Asserted three ways:
 *
 *   the rating   every finding type whose repair is one of the four is rated
 *                `approval` (Tier 2, no autonomous path), and the repairs that
 *                stay automatic are still `auto`
 *   the kernel   the autonomous path parks each of them and runs nothing
 *   the loop     a real reconciler tick parks unadopted external DDL, applies
 *                the index and RLS repairs beside it, leaves the parked one
 *                alone on the next tick, and approving it runs the adoption
 *                exactly once
 *
 * The kernel and the loop run against a real PostgreSQL. What each assertion
 * reads is ground truth: the catalog, the drift events and the audit rows.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { classifyFix } from '@/lib/core/fix-classifier'
import {
  REPAIRS_OUTSIDE_THE_CHANGE_LEDGER,
  buildFixAction,
  runsOutsideChangeLedger,
} from '@/lib/core/fix-actions'
import { ALL_FINDING_TYPES } from '@/lib/core/types'
import { deriveTier } from '@/lib/autonomy/desired-state'
import { authorityPathFor, LEGACY_AUTONOMY_COMPAT_TYPES } from '@/lib/authority/action-classes'
import { executeApprovedFix, processOpenFindings } from '@/lib/core/auto-fix-engine'
import { runReconcilerLive } from '@/lib/autonomy/reconciler'
import { captureSchemaSnapshot } from '@/lib/services/workspace-schema-snapshot'

process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

/** The finding types whose repair is one of the four, with the details their writers record. */
const OUTSIDE_THE_LEDGER: Array<[type: string, action: string, details: Record<string, unknown>]> = [
  ['api_drift', 'FIX_API', { tableName: 'notes' }],
  ['missing_api_definition', 'FIX_API', { tableName: 'notes' }],
  ['missing_api_crud', 'FIX_API', { tableName: 'notes' }],
  ['shadow_mutation', 'FIX_API', { tableName: 'notes', shadowColumns: ['secret_flag'] }],
  ['workflow_broken', 'FIX_WORKFLOW', { workflow: 'user_auth_flow', missingComponents: ['rls_on_users'] }],
  ['verification_failed', 'FIX_WORKFLOW', { category: 'rls' }],
  ['external_schema_change', 'ADOPT_EXTERNAL_SCHEMA', { location: 'direct-connection', eventCount: 1 }],
  ['schema_not_registered', 'REGISTER_SCHEMA', { schema: 'workspace_x', tableCount: 2 }],
  // The same repairs reached under the names other writers use.
  ['schema_drift', 'FIX_API', { description: 'column added outside the platform' }],
  ['missing_api_orders', 'FIX_API', { location: 'orders' }],
]

/** Repairs that keep applying themselves, with the details their detectors record. */
const STILL_AUTOMATIC: Array<[type: string, details: Record<string, unknown>]> = [
  ['missing_rls', { tableName: 'notes' }],
  ['unprotected_user_data', { tableName: 'notes' }],
  ['rls_denies_everything', { tableName: 'notes' }],
  ['rls_expression_invalid', { tableName: 'notes', policyName: 'p_open' }],
  ['missing_fk_index', { tableName: 'line_items', columnName: 'order_id' }],
  ['slow_query_missing_index', { tableName: 'line_items', columnName: 'order_id' }],
  ['infra_hot_table', { tableName: 'line_items', columnName: 'order_id' }],
  ['infra_table_bloat', { tableName: 'line_items' }],
  ['index_bloat', { tableName: 'line_items', indexName: 'idx_line_items_order_id' }],
  ['missing_rate_limit', { tableName: 'notes' }],
  ['realtime_gap', { tableName: 'notes' }],
  ['orphan_table', { tableName: 'legacy_events' }],
]

// ── The rating ───────────────────────────────────────────────────────────────

describe('the rating', () => {
  test('the four are exactly the repairs that run outside the change ledger', () => {
    expect([...REPAIRS_OUTSIDE_THE_CHANGE_LEDGER].sort()).toEqual(
      ['ADOPT_EXTERNAL_SCHEMA', 'FIX_API', 'FIX_WORKFLOW', 'REGISTER_SCHEMA'],
    )
    expect(runsOutsideChangeLedger('FIX_API')).toBe(true)
    expect(runsOutsideChangeLedger('CREATE_INDEX')).toBe(false)
    expect(runsOutsideChangeLedger(undefined)).toBe(false)
  })

  test.each(OUTSIDE_THE_LEDGER)('%s waits for a person, with %s behind the approval', (type, action, details) => {
    expect(buildFixAction(type, details)?.action).toBe(action)
    const c = classifyFix(type, details)
    expect(c.decision).toBe('approval')
    // The Review Queue shows this as the reason it is waiting.
    expect(c.reason).toMatch(/outside your change history, so History could not undo it/)
    expect(deriveTier(type, details)).toBe(2)
  })

  test('none of them has an autonomous path left', () => {
    for (const [type] of OUTSIDE_THE_LEDGER) {
      expect(LEGACY_AUTONOMY_COMPAT_TYPES.has(type)).toBe(false)
      expect(authorityPathFor(type)).toBe('freeze')
    }
  })

  test('no finding type whose repair runs outside the ledger is ever rated auto', () => {
    // Over every type the platform declares, so a new type mapped to one of the
    // four cannot ship rated `auto`. Generic details carry every locator a
    // detector writes, so no type escapes the check for want of a field.
    const details = {
      tableName: 'notes',
      columnName: 'user_id',
      indexName: 'idx_notes_user_id',
      workflow: 'user_auth_flow',
      schema: 'workspace_x',
      surface: 'db',
      httpStatus: 502,
    }
    const outside: string[] = []
    for (const type of ALL_FINDING_TYPES) {
      const fix = buildFixAction(type, details)
      if (!fix || !runsOutsideChangeLedger(fix.action)) continue
      outside.push(type)
      expect([type, classifyFix(type, details).decision]).toEqual([type, 'approval'])
    }
    // Pinned so a new mapping to one of the four is a reviewed edit.
    // dead_api_endpoint was already approval-gated: its repair removes an endpoint.
    expect(outside.sort()).toEqual([
      'api_drift',
      'dead_api_endpoint',
      'external_schema_change',
      'missing_api_crud',
      'missing_api_definition',
      'schema_not_registered',
      'shadow_mutation',
      'verification_failed',
      'workflow_broken',
    ])
  })

  test('a held agent call naming one of the four is never run by the loop', () => {
    // An agent's own parked call replays only when a person approves it; the
    // loop never rates it auto, whatever it names.
    for (const executorAction of REPAIRS_OUTSIDE_THE_CHANGE_LEDGER) {
      const d = { executorAction, executorParams: {} }
      expect(classifyFix('ai_action_pending', d).decision).not.toBe('auto')
    }
  })

  test.each(STILL_AUTOMATIC)('%s still applies itself', (type, details) => {
    expect(classifyFix(type, details).decision).toBe('auto')
    expect([0, 1]).toContain(deriveTier(type, details))
    expect(authorityPathFor(type)).not.toBe('freeze')
    const fix = buildFixAction(type, details)
    expect(fix).not.toBeNull()
    expect(runsOutsideChangeLedger(fix!.action)).toBe(false)
  })
})

// ── Fixture ──────────────────────────────────────────────────────────────────

let userId: string
let planId: string
const projects: string[] = []

async function project(name: string): Promise<{ projectId: string; schema: string }> {
  const projectId = randomUUID()
  const schema = `workspace_${projectId}`
  await prisma.project.create({ data: { id: projectId, name, userId, autonomyLevel: 'AGGRESSIVE' } as any })
  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  projects.push(projectId)
  return { projectId, schema }
}

const audits = async (projectId: string, action: string) =>
  (await prisma.auditLog.findMany({ where: { projectId, action }, select: { details: true } }))
    .map((r) => JSON.parse(String(r.details)) as Record<string, any>)

const pendingDriftEvents = (projectId: string) =>
  prisma.schemaDriftEvent.count({ where: { projectId, status: 'pending' } })

async function indexed(schema: string, table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
    SELECT count(*)::int AS n
    FROM pg_index i
    JOIN pg_class c     ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = '${schema}' AND c.relname = '${table}' AND a.attname = '${column}'
  `)
  return rows[0].n > 0
}

async function rlsOn(schema: string, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ on: boolean }>>(
    `SELECT relrowsecurity AS on FROM pg_class WHERE oid = '"${schema}"."${table}"'::regclass`,
  )
  return rows[0].on
}

beforeAll(async () => {
  userId = randomUUID()
  await prisma.user.create({
    data: { id: userId, email: `outside-ledger+${userId.slice(0, 8)}@backenly.test`, name: 'outside the ledger', password: 'not-a-real-hash' },
  })
  // What seed-billing gives every tier: 1-minute cadence, AGGRESSIVE ceiling,
  // no per-window cap. Nothing but the rating holds these repairs back.
  const plan = await prisma.plan.create({
    data: {
      name: `OUTSIDE_LEDGER_${userId.slice(0, 8)}`,
      priceCents: 0,
      autonomyScanIntervalMin: 1,
      autonomyMaxLevel: 'AGGRESSIVE',
      autonomyMaxActionsPerWindow: null,
    } as any,
  })
  planId = plan.id
  await prisma.subscription.create({ data: { userId, planId, status: 'ACTIVE' } as any })
}, 120_000)

afterAll(async () => {
  for (const projectId of projects) {
    await q(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
    await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.schemaDriftEvent.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.permissionPolicy.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  await prisma.subscription.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.plan.deleteMany({ where: { id: planId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

// ── The kernel ───────────────────────────────────────────────────────────────

describe('the kernel', () => {
  it('parks every one of them on the autonomous path and runs nothing', async () => {
    const { projectId } = await project('outside-ledger-kernel')
    const ids = new Map<string, string>()
    for (const [type, , details] of OUTSIDE_THE_LEDGER) {
      const f = await prisma.healthFinding.create({
        data: { projectId, type, severity: 'warning', status: 'open', autoFixed: false, details: details as any },
      })
      ids.set(f.id, type)
    }

    // processOpenFindings is what the repair loop and the agentic fix loop's
    // first phase both run, and its default actor is the autonomous one.
    const results = await processOpenFindings(projectId)

    expect(results).toHaveLength(OUTSIDE_THE_LEDGER.length)
    for (const r of results) {
      expect([ids.get(r.findingId), r.outcome]).toEqual([ids.get(r.findingId), 'pending_approval'])
      // The approval branch's own words, not a failed attempt's.
      const type = ids.get(r.findingId)!
      expect(r.message).toBe(classifyFix(type, OUTSIDE_THE_LEDGER.find(([t]) => t === type)![2]).reason)
    }
    const rows = await prisma.healthFinding.findMany({ where: { projectId }, select: { status: true } })
    expect(rows.every((f) => f.status === 'pending_approval')).toBe(true)

    // Each is recorded as waiting, and nothing reached an execution path: the
    // legacy bridge records its use before it executes, and a run that failed
    // or could not be verified records that.
    expect((await audits(projectId, 'HEALTH_FIX_AWAITING_APPROVAL')).map((d) => d.findingType).sort()).toEqual(
      OUTSIDE_THE_LEDGER.map(([t]) => t).sort(),
    )
    for (const action of ['AUTHORITY_LEGACY_COMPATIBILITY', 'HEALTH_AUTO_FIXED', 'HEALTH_FIX_ESCALATED', 'HEALTH_FIX_UNVERIFIED']) {
      expect([action, (await audits(projectId, action)).length]).toEqual([action, 0])
    }
  }, 180_000)
})

// ── The loop ─────────────────────────────────────────────────────────────────

describe('the reconciler', () => {
  it('applies the index and RLS repairs itself, and parks the API re-sync beside them', async () => {
    const { projectId, schema } = await project('outside-ledger-applies')
    // An unindexed reference column: an index the loop applies on its own.
    await q(`CREATE TABLE "${schema}"."line_items" (id uuid PRIMARY KEY, order_id uuid)`)
    // User data with no policy: an RLS repair the loop applies on its own.
    await q(`CREATE TABLE "${schema}"."notes" (id uuid PRIMARY KEY, user_id uuid, body text)`)
    for (const name of ['line_items', 'notes']) {
      await prisma.table.create({ data: { projectId, name, schema, description: 'fixture' } })
    }
    // A column added outside the platform after the last snapshot. Its repair,
    // FIX_API re-syncing the API layer, runs outside the change ledger.
    expect(await captureSchemaSnapshot(projectId, 'post_migration')).not.toBeNull()
    await q(`ALTER TABLE "${schema}"."notes" ADD COLUMN secret_flag boolean DEFAULT false`)

    const res = await runReconcilerLive(projectId)
    expect(res).not.toBeNull()
    expect(res!.frozen).toBe(false)

    // The repairs that stay automatic applied themselves, read from the catalog.
    expect(await indexed(schema, 'line_items', 'order_id')).toBe(true)
    expect(await rlsOn(schema, 'notes')).toBe(true)
    const fixed = await audits(projectId, 'HEALTH_AUTO_FIXED')
    expect(fixed.some((d) => d.findingType === 'missing_fk_index' && d.tableName === 'line_items')).toBe(true)
    // Whichever RLS finding reached the kernel first carried the repair.
    expect(fixed.some((d) => ['unprotected_user_data', 'missing_rls'].includes(d.findingType) && d.tableName === 'notes')).toBe(true)

    // The API re-sync did not run: parked for a person, and no attempt of it is
    // on record, whether it worked, failed or could not be verified.
    expect(res!.parked).toBe(1)
    const shadow = await prisma.healthFinding.findMany({ where: { projectId, type: 'shadow_mutation' }, select: { status: true } })
    expect(shadow).toEqual([{ status: 'pending_approval' }])
    expect((await audits(projectId, 'HEALTH_FIX_AWAITING_APPROVAL')).map((d) => d.findingType)).toEqual(['shadow_mutation'])
    for (const action of ['HEALTH_AUTO_FIXED', 'HEALTH_FIX_ESCALATED', 'HEALTH_FIX_UNVERIFIED']) {
      expect([action, (await audits(projectId, action)).filter((d) => d.findingType === 'shadow_mutation')]).toEqual([action, []])
    }
  }, 300_000)

  describe('with DDL that arrived over a direct connection', () => {
    let projectId: string

    beforeAll(async () => {
      let schema: string
      ;({ projectId, schema } = await project('outside-ledger-adopt'))
      await q(`CREATE TABLE "${schema}"."notes" (id uuid PRIMARY KEY, body text)`)
      await prisma.table.create({ data: { projectId, name: 'notes', schema, description: 'fixture' } })
      // Recorded by the drift watch and not yet adopted. Its repair,
      // ADOPT_EXTERNAL_SCHEMA, runs outside the change ledger, and adopting is
      // what marks the event: a pending event means adoption has not run.
      await prisma.schemaDriftEvent.create({
        data: {
          projectId,
          roleName: 'external_rw',
          commandTag: 'ALTER TABLE',
          objectIdentity: `${schema}.notes`,
          schemaName: schema,
          status: 'pending',
        } as any,
      })
    }, 120_000)

    const adoptFindings = () =>
      prisma.healthFinding.findMany({
        where: { projectId, type: 'external_schema_change' },
        select: { id: true, status: true },
      })

    it('parks the adoption for a person instead of running it', async () => {
      const res = await runReconcilerLive(projectId)
      expect(res).not.toBeNull()
      expect(res!.frozen).toBe(false)

      expect(res!.parked).toBe(1)
      expect(await pendingDriftEvents(projectId)).toBe(1)
      expect((await adoptFindings()).map((f) => f.status)).toEqual(['pending_approval'])
      expect((await audits(projectId, 'HEALTH_FIX_AWAITING_APPROVAL')).map((d) => d.findingType)).toEqual([
        'external_schema_change',
      ])
    }, 300_000)

    it('leaves the parked finding alone on the next tick', async () => {
      const res = await runReconcilerLive(projectId)
      expect(res).not.toBeNull()

      expect(res!.parked).toBe(0)
      expect(await pendingDriftEvents(projectId)).toBe(1)
      expect((await adoptFindings()).map((f) => f.status)).toEqual(['pending_approval'])
      // Not handed back to the kernel as a failed fix to retry, and not parked twice.
      const retried = (await audits(projectId, 'AUTONOMY_ESCALATION_RETRIED')).filter((d) => d.findingType === 'external_schema_change')
      expect(retried).toEqual([])
      expect(await audits(projectId, 'HEALTH_FIX_AWAITING_APPROVAL')).toHaveLength(1)
    }, 300_000)

    it('runs the adoption once a person approves it, with no second approval', async () => {
      const [parked] = await adoptFindings()

      const result = await executeApprovedFix(parked.id, projectId)

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Adopted 1 external schema change/)
      expect(result.verification).toBe('confirmed')
      expect(await pendingDriftEvents(projectId)).toBe(0)
      // The executor's own risk gate parks an unconfirmed call as an
      // ai_action_pending finding. None was filed: the approval was enough.
      expect(await prisma.healthFinding.count({ where: { projectId, type: 'ai_action_pending' } })).toBe(0)

      // What the approve route then records, so the next tick sees it settled.
      await prisma.healthFinding.update({
        where: { id: parked.id },
        data: { status: 'auto_fixed', autoFixed: true, fixAppliedAt: new Date() },
      })
      const after = await runReconcilerLive(projectId)
      expect(after!.parked).toBe(0)
      expect(await adoptFindings()).toEqual([{ id: parked.id, status: 'auto_fixed' }])
    }, 300_000)
  })
})
