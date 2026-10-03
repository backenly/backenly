/**
 * ROLLBACK, AGAINST A REAL DATABASE
 * =================================
 *
 * The claim is that PostgreSQL ends up in a particular state, so the evidence
 * has to be PostgreSQL. A mocked executor would prove the branches and none of
 * the recovery.
 *
 * The decisive assertions are all catalog reads taken after the fact, and the
 * adversarial half matters more than the happy path: the dangerous failure
 * mode automatic recovery introduces is not "rollback did not work", it is
 *
 *     Backenly added X -> somebody legitimately replaced X
 *     -> Backenly later "undid its own work" and destroyed the replacement
 *
 * ── Why these build ledger rows directly ──────────────────────────────────
 *
 * Every ladder the planner emits is currently `blocked_by_capability`, because
 * `drop_constraint` has no executor. So there is no way to reach a step
 * execution through a full ladder run today, and a test that waited for one
 * would be testing nothing. These construct the execution record the forward
 * path writes and then drive the real state machine against it.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

/**
 * Arms an observation to throw, once, N calls from now.
 *
 * The rollback verifier and this file's fixtures both call `observeResource`,
 * so a blanket mock would break the setup as well as the thing under test.
 * Armed immediately before `performRollback`, which observes twice: the stale
 * guard first, then the post-inverse verification.
 */
let observeThrowsAfter: number | null = null

jest.mock('@/lib/autonomy/maintenance/resource-state', () => {
  const actual = jest.requireActual('@/lib/autonomy/maintenance/resource-state')
  return {
    ...actual,
    observeResource: async (...args: unknown[]) => {
      if (observeThrowsAfter !== null) {
        if (observeThrowsAfter === 0) {
          observeThrowsAfter = null
          throw new Error('connection terminated unexpectedly')
        }
        observeThrowsAfter -= 1
      }
      return (actual as { observeResource: (...a: unknown[]) => unknown }).observeResource(...args)
    },
  }
})

import { performRollback, markRollbackEligible } from '@/lib/autonomy/maintenance/rollback'
import { observeResource, type ResourceIdentity } from '@/lib/autonomy/maintenance/resource-state'
import { closeMaintenanceLockPool } from '@/lib/autonomy/maintenance/single-flight'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let projectId: string
let schema: string
let executionId: string

/** Does the catalog currently show this column? The ground truth. */
async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM information_schema.columns
      WHERE table_schema = '${schema}' AND table_name = '${table}' AND column_name = '${column}'`,
  )
  return Number(rows[0]?.n ?? 0) > 0
}

/**
 * Write the execution record the forward path would have written.
 *
 * `observedPostState` is OBSERVED here rather than asserted, so the fixture
 * cannot accidentally record a shape the database does not actually have —
 * which would make every stale check pass for the wrong reason.
 */
async function recordStep(opts: {
  strategy: string
  identity: ResourceIdentity | null
  preState: unknown
  observePost: boolean
  result?: unknown
}): Promise<string> {
  const post = opts.observePost && opts.identity
    ? await observeResource(projectId, opts.identity)
    : null
  const row = await prisma.maintenanceStepExecution.create({
    data: {
      executionId,
      stepId: '0',
      stepKind: 'add_structure',
      ordinal: 0,
      idempotencyKey: randomUUID(),
      status: 'completed',
      rollback: { strategy: opts.strategy, description: 'fixture' },
      resourceIdentity: opts.identity as object,
      observedPreState: opts.preState as object,
      observedPostState: post as object,
      result: (opts.result ?? {}) as object,
    },
  })
  return row.id
}

beforeEach(() => {
  observeThrowsAfter = null
})

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `rollback+${userId.slice(0, 8)}@backenly.test`,
      name: 'rollback fixture',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({ data: { id: projectId, name: 'rollback-fixture', userId } as any })
  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  // `resolveWorkspaceSchema` prefers the STORED name, so the fixture has to
  // store it. Without this the observer reads a schema that does not exist,
  // every column reads as absent, and the stale checks below would pass for
  // entirely the wrong reason.
  await prisma.workspace.create({
    data: { name: 'rollback-fixture', projectId, postgresSchema: schema } as any,
  })

  const ex = await prisma.maintenanceExecution.create({
    data: {
      projectId,
      findingId: 'f-fixture',
      planId: 'plan-fixture',
      planVersion: 1,
      catalogFingerprint: 'cat-v1',
      tier: '1',
      status: 'completed',
    },
  })
  executionId = ex.id
}, 240_000)

afterAll(async () => {
  await prisma.maintenanceStepExecution.deleteMany({ where: { executionId } }).catch(() => {})
  await prisma.maintenanceExecution.deleteMany({ where: { projectId } }).catch(() => {})
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.workspace.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await closeMaintenanceLockPool()
  await prisma.$disconnect()
}, 240_000)

// ── drop_column, end to end ─────────────────────────────────────────────────

describe('drop_column restores the database, not just the ledger', () => {
  it('removes the exact column the forward step added, and proves it', async () => {
    await q(`CREATE TABLE "${schema}"."orders" (id uuid PRIMARY KEY)`)
    const identity: ResourceIdentity = { kind: 'column', table: 'orders', column: 'state' }

    // Pre-state: observed BEFORE the column exists. This is what rollback has
    // to restore the world to.
    const pre = await observeResource(projectId, identity)
    expect(pre).toEqual({ kind: 'column', present: false })

    await q(`ALTER TABLE "${schema}"."orders" ADD COLUMN state text`)
    expect(await columnExists('orders', 'state')).toBe(true)

    const stepId = await recordStep({ strategy: 'drop_column', identity, preState: pre, observePost: true })
    expect(await markRollbackEligible(stepId, 'forward verification positively failed')).toBe(true)

    const r = await performRollback({ projectId, stepExecutionId: stepId })

    expect(`${r.status}: ${r.detail}`).toBe('verified: the prior state was restored and independently confirmed')
    // Ground truth. If this still said true, the ledger would be claiming a
    // restoration that did not happen.
    expect(await columnExists('orders', 'state')).toBe(false)

    const row = await prisma.maintenanceStepExecution.findUnique({ where: { id: stepId } })
    expect(row!.rollbackStatus).toBe('verified')
    expect(row!.rollbackAt).toBeInstanceOf(Date)
  }, 300_000)
})

// ── The stale guard: the reason this feature is dangerous ───────────────────

describe('a resource that somebody else changed is never undone', () => {
  it('refuses when the column was recreated with a different type', async () => {
    await q(`CREATE TABLE "${schema}"."invoices" (id uuid PRIMARY KEY)`)
    const identity: ResourceIdentity = { kind: 'column', table: 'invoices', column: 'state' }
    const pre = await observeResource(projectId, identity)

    await q(`ALTER TABLE "${schema}"."invoices" ADD COLUMN state text`)
    const stepId = await recordStep({ strategy: 'drop_column', identity, preState: pre, observePost: true })

    // Somebody legitimately replaces it. Same name, different column.
    await q(`ALTER TABLE "${schema}"."invoices" DROP COLUMN state`)
    await q(`ALTER TABLE "${schema}"."invoices" ADD COLUMN state integer NOT NULL DEFAULT 0`)

    await markRollbackEligible(stepId, 'forward verification positively failed')
    const r = await performRollback({ projectId, stepExecutionId: stepId })

    expect(r.status).toBe('blocked_stale')
    expect(r.detail).toMatch(/type text -> int4|altered/)
    // THE assertion. The replacement survives.
    expect(await columnExists('invoices', 'state')).toBe(true)
  }, 300_000)

  it('refuses when the column is already gone, rather than reporting success', async () => {
    await q(`CREATE TABLE "${schema}"."shipments" (id uuid PRIMARY KEY)`)
    const identity: ResourceIdentity = { kind: 'column', table: 'shipments', column: 'state' }
    const pre = await observeResource(projectId, identity)
    await q(`ALTER TABLE "${schema}"."shipments" ADD COLUMN state text`)
    const stepId = await recordStep({ strategy: 'drop_column', identity, preState: pre, observePost: true })

    await q(`ALTER TABLE "${schema}"."shipments" DROP COLUMN state`)

    await markRollbackEligible(stepId, 'forward verification positively failed')
    const r = await performRollback({ projectId, stepExecutionId: stepId })

    // The end state happens to be what rollback wanted, and it still refuses.
    // Something else acted on this resource, and "the outcome is convenient"
    // is not evidence that undoing our own work is what happened.
    expect(r.status).toBe('blocked_stale')
    expect(r.detail).toMatch(/already gone/)
  }, 300_000)
})

// ── The rules inherited from the forward verifier ───────────────────────────

describe('rollback only runs on a positive forward failure', () => {
  it('refuses a step nobody marked eligible', async () => {
    await q(`CREATE TABLE "${schema}"."refunds" (id uuid PRIMARY KEY)`)
    const identity: ResourceIdentity = { kind: 'column', table: 'refunds', column: 'state' }
    const pre = await observeResource(projectId, identity)
    await q(`ALTER TABLE "${schema}"."refunds" ADD COLUMN state text`)
    const stepId = await recordStep({ strategy: 'drop_column', identity, preState: pre, observePost: true })

    // No markRollbackEligible. A verification_error, a timeout, or anything
    // else that did not POSITIVELY establish failure leaves the row null, and
    // a null must never enter the machine.
    const r = await performRollback({ projectId, stepExecutionId: stepId })

    expect(r.status).toBe('failed')
    expect(r.detail).toMatch(/never marked rollback-eligible/)
    expect(await columnExists('refunds', 'state')).toBe(true)
  }, 300_000)

  it('refuses a step that recorded no observed state at all', async () => {
    // Executions written before recovery authority existed. Without the
    // observed post-state there is nothing to tell this resource from a later
    // one wearing the same name, so the only safe answer is to refuse.
    await q(`CREATE TABLE "${schema}"."legacy" (id uuid PRIMARY KEY, state text)`)
    const stepId = await recordStep({
      strategy: 'drop_column',
      identity: { kind: 'column', table: 'legacy', column: 'state' },
      preState: null,
      observePost: false,
    })
    await markRollbackEligible(stepId, 'forward verification positively failed')

    const r = await performRollback({ projectId, stepExecutionId: stepId })
    expect(r.status).toBe('blocked_stale')
    expect(r.detail).toMatch(/predates recovery authority/)
    expect(await columnExists('legacy', 'state')).toBe(true)
  }, 300_000)

  it('refuses a strategy this deployment cannot perform', async () => {
    await q(`CREATE TABLE "${schema}"."taxes" (id uuid PRIMARY KEY, state text)`)
    const identity: ResourceIdentity = { kind: 'column', table: 'taxes', column: 'state' }
    const stepId = await recordStep({
      strategy: 'drop_constraint',
      identity,
      preState: { kind: 'column', present: false },
      observePost: true,
    })
    await markRollbackEligible(stepId, 'forward verification positively failed')

    const r = await performRollback({ projectId, stepExecutionId: stepId })
    expect(r.status).toBe('failed')
    expect(r.detail).toMatch(/cannot perform drop_constraint/)
    expect(await columnExists('taxes', 'state')).toBe(true)
  }, 300_000)
})

// ── The transition is claimed once ──────────────────────────────────────────

describe('two callers cannot both own one rollback', () => {
  it('lets exactly one through and leaves the other with nothing to do', async () => {
    await q(`CREATE TABLE "${schema}"."ledgers" (id uuid PRIMARY KEY)`)
    const identity: ResourceIdentity = { kind: 'column', table: 'ledgers', column: 'state' }
    const pre = await observeResource(projectId, identity)
    await q(`ALTER TABLE "${schema}"."ledgers" ADD COLUMN state text`)
    const stepId = await recordStep({ strategy: 'drop_column', identity, preState: pre, observePost: true })
    await markRollbackEligible(stepId, 'forward verification positively failed')

    const [a, b] = await Promise.all([
      performRollback({ projectId, stepExecutionId: stepId }),
      performRollback({ projectId, stepExecutionId: stepId }),
    ])

    // EXACTLY ONE performed it. The other either lost the project lock or
    // found the row already settled and reported that state back - which is
    // why the assertion is on the detail rather than the status: "I restored
    // it" and "it was already restored" are both `verified`, and only the
    // first may happen once.
    const details = [a.detail, b.detail]
    const performed = details.filter(d => /restored and independently confirmed/.test(d))
    const observed = details.filter(d => /already|another process/.test(d))
    expect(performed.length).toBe(1)
    expect(observed.length).toBe(1)

    expect(await columnExists('ledgers', 'state')).toBe(false)

    // And the ledger records one settlement, not two attempts.
    const row = await prisma.maintenanceStepExecution.findUnique({ where: { id: stepId } })
    expect(row!.rollbackStatus).toBe('verified')
  }, 300_000)

  it('marks a step eligible only once', async () => {
    const stepId = await recordStep({
      strategy: 'none_required',
      identity: null,
      preState: null,
      observePost: false,
    })
    expect(await markRollbackEligible(stepId, 'first')).toBe(true)
    // The second caller does not get to re-open a decision somebody owns.
    expect(await markRollbackEligible(stepId, 'second')).toBe(false)
  }, 300_000)
})

// ── drop_trigger, end to end ────────────────────────────────────────────────

/** Install a dual-write-shaped trigger, named the way the primitive names them. */
async function installTrigger(table: string, column: string) {
  const name = `bkn_dw_${table}_${column}`
  await q(`CREATE OR REPLACE FUNCTION "${schema}"."${name}"() RETURNS trigger
           LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;`)
  await q(`CREATE TRIGGER "${name}" BEFORE INSERT ON "${schema}"."${table}"
           FOR EACH ROW EXECUTE FUNCTION "${schema}"."${name}"();`)
  return name
}

async function triggerNames(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT t.tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${schema}' AND c.relname = '${table}' AND NOT t.tgisinternal
      ORDER BY t.tgname`,
  )
  return rows.map(r => r.tgname)
}

describe('drop_trigger removes the maintenance trigger and nothing else', () => {
  it('drops it, proves it is gone, and leaves unrelated triggers intact', async () => {
    await q(`CREATE TABLE "${schema}"."events" (id uuid PRIMARY KEY, state text)`)
    // An unrelated trigger the project owns. Recovery must not touch it.
    await q(`CREATE OR REPLACE FUNCTION "${schema}"."app_audit"() RETURNS trigger
             LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;`)
    await q(`CREATE TRIGGER "app_audit" AFTER INSERT ON "${schema}"."events"
             FOR EACH ROW EXECUTE FUNCTION "${schema}"."app_audit"();`)

    const identity: ResourceIdentity = {
      kind: 'trigger', table: 'events', trigger: 'bkn_dw_events_state', targetColumn: 'state',
    }
    const pre = await observeResource(projectId, identity)
    expect(pre).toEqual({ kind: 'trigger', present: false })

    await installTrigger('events', 'state')
    expect(await triggerNames('events')).toEqual(['app_audit', 'bkn_dw_events_state'])

    const stepId = await recordStep({ strategy: 'drop_trigger', identity, preState: pre, observePost: true })
    await markRollbackEligible(stepId, 'forward verification positively failed')
    const r = await performRollback({ projectId, stepExecutionId: stepId })

    expect(`${r.status}: ${r.detail}`).toBe(
      'verified: the prior state was restored and independently confirmed',
    )
    // Ground truth, both halves: ours is gone, theirs survives.
    expect(await triggerNames('events')).toEqual(['app_audit'])
  }, 300_000)

  it('refuses when the trigger was redefined after the step ran', async () => {
    await q(`CREATE TABLE "${schema}"."signals" (id uuid PRIMARY KEY, state text)`)
    const identity: ResourceIdentity = {
      kind: 'trigger', table: 'signals', trigger: 'bkn_dw_signals_state', targetColumn: 'state',
    }
    const pre = await observeResource(projectId, identity)
    await installTrigger('signals', 'state')
    const stepId = await recordStep({ strategy: 'drop_trigger', identity, preState: pre, observePost: true })

    // Somebody repoints the same trigger name at different timing. Same name,
    // materially different object.
    await q(`DROP TRIGGER "bkn_dw_signals_state" ON "${schema}"."signals"`)
    await q(`CREATE TRIGGER "bkn_dw_signals_state" AFTER UPDATE ON "${schema}"."signals"
             FOR EACH ROW EXECUTE FUNCTION "${schema}"."bkn_dw_signals_state"();`)

    await markRollbackEligible(stepId, 'forward verification positively failed')
    const r = await performRollback({ projectId, stepExecutionId: stepId })

    expect(r.status).toBe('blocked_stale')
    expect(r.detail).toMatch(/redefined/)
    // Untouched. Somebody else's trigger definition is not ours to drop.
    expect(await triggerNames('signals')).toEqual(['bkn_dw_signals_state'])
  }, 300_000)

  it('becomes unverified, never verified, when the check cannot run', async () => {
    await q(`CREATE TABLE "${schema}"."pulses" (id uuid PRIMARY KEY, state text)`)
    const identity: ResourceIdentity = {
      kind: 'trigger', table: 'pulses', trigger: 'bkn_dw_pulses_state', targetColumn: 'state',
    }
    const pre = await observeResource(projectId, identity)
    await installTrigger('pulses', 'state')
    const stepId = await recordStep({ strategy: 'drop_trigger', identity, preState: pre, observePost: true })
    await markRollbackEligible(stepId, 'forward verification positively failed')

    // Two observations happen inside performRollback: the stale guard, then
    // the post-inverse verification. Let the first through and break the
    // second, which is the case where the inverse really ran.
    observeThrowsAfter = 1
    const r = await performRollback({ projectId, stepExecutionId: stepId })

    expect(r.status).toBe('unverified')
    expect(r.detail).toMatch(/NOT a restoration/)
    const row = await prisma.maintenanceStepExecution.findUnique({ where: { id: stepId } })
    expect(row!.rollbackStatus).toBe('unverified')
  }, 300_000)
})

// ── restore_reader_config, end to end ───────────────────────────────────────

async function makeReader(name: string, code: string): Promise<string> {
  const fn = await prisma.aiFunction.create({
    data: {
      projectId, name, description: 'rollback fixture',
      generatedCode: code, triggerType: 'manual', status: 'inactive',
    } as any,
  })
  return fn.id
}

const codeOf = async (id: string) =>
  (await prisma.aiFunction.findUnique({ where: { id }, select: { generatedCode: true } }))!.generatedCode

describe('restore_reader_config puts the exact previous source back', () => {
  it('restores configuration A after a switch to B, byte for byte', async () => {
    const A = 'export default async () => ({ read: "status" })'
    const B = 'export default async () => ({ read: "state" })'
    const id1 = await makeReader('reader_one', A)
    const id2 = await makeReader('reader_two', A)

    const identity: ResourceIdentity = { kind: 'readers', functionIds: [id1, id2] }
    const pre = await observeResource(projectId, identity)

    // The forward switch.
    await prisma.aiFunction.updateMany({ where: { id: { in: [id1, id2] } }, data: { generatedCode: B } })

    const stepId = await recordStep({
      strategy: 'restore_reader_config',
      identity,
      preState: pre,
      observePost: true,
      // The bytes the primitive records. Rollback restores from these rather
      // than re-deriving anything; a regenerated equivalent is not a
      // restoration.
      result: {
        switchedReaders: [
          { kind: 'ai_function', id: id1, name: 'reader_one', replacements: 1, previousCode: A },
          { kind: 'ai_function', id: id2, name: 'reader_two', replacements: 1, previousCode: A },
        ],
      },
    })
    await markRollbackEligible(stepId, 'forward verification positively failed')
    const r = await performRollback({ projectId, stepExecutionId: stepId })

    expect(`${r.status}: ${r.detail}`).toBe(
      'verified: the prior state was restored and independently confirmed',
    )
    // Ground truth, read back from the rows themselves.
    expect(await codeOf(id1)).toBe(A)
    expect(await codeOf(id2)).toBe(A)
  }, 300_000)

  it('refuses when a reader moved on to C after the switch', async () => {
    const A = 'export default async () => ({ v: "a" })'
    const B = 'export default async () => ({ v: "b" })'
    const C = 'export default async () => ({ v: "c" })'
    const id = await makeReader('reader_three', A)

    const identity: ResourceIdentity = { kind: 'readers', functionIds: [id] }
    const pre = await observeResource(projectId, identity)
    await prisma.aiFunction.update({ where: { id }, data: { generatedCode: B } })

    const stepId = await recordStep({
      strategy: 'restore_reader_config',
      identity,
      preState: pre,
      observePost: true,
      result: {
        switchedReaders: [
          { kind: 'ai_function', id, name: 'reader_three', replacements: 1, previousCode: A },
        ],
      },
    })

    // The owner, or their agent, legitimately edits the function afterwards.
    await prisma.aiFunction.update({ where: { id }, data: { generatedCode: C } })

    await markRollbackEligible(stepId, 'forward verification positively failed')
    const r = await performRollback({ projectId, stepExecutionId: stepId })

    expect(r.status).toBe('blocked_stale')
    expect(r.detail).toMatch(/changed since the switch/)
    // C survives. Restoring A here would silently discard their work.
    expect(await codeOf(id)).toBe(C)
  }, 300_000)
})

// ── Accounting ──────────────────────────────────────────────────────────────

describe('only the caller that performed a rollback is counted as having done one', () => {
  it('writes exactly one audit row when two callers race', async () => {
    await q(`CREATE TABLE "${schema}"."counts" (id uuid PRIMARY KEY)`)
    const identity: ResourceIdentity = { kind: 'column', table: 'counts', column: 'state' }
    const pre = await observeResource(projectId, identity)
    await q(`ALTER TABLE "${schema}"."counts" ADD COLUMN state text`)
    const stepId = await recordStep({ strategy: 'drop_column', identity, preState: pre, observePost: true })
    await markRollbackEligible(stepId, 'forward verification positively failed')

    const before = await prisma.auditLog.count({
      where: { projectId, action: 'MAINTENANCE_ROLLBACK_PERFORMED' },
    })

    await Promise.all([
      performRollback({ projectId, stepExecutionId: stepId }),
      performRollback({ projectId, stepExecutionId: stepId }),
    ])

    const after = await prisma.auditLog.count({
      where: { projectId, action: 'MAINTENANCE_ROLLBACK_PERFORMED' },
    })
    // "Already restored when I looked" is evidence of current state, not a
    // second recovery action, and must not inflate the rollback figure.
    expect(after - before).toBe(1)
  }, 300_000)
})
