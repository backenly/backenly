/**
 * A VERIFIER THAT THROWS MUST NOT CERTIFY A FIX
 * =============================================
 *
 * `evaluateFixOutcome` was called as `.catch(() => null)` and every guard after
 * it read `if (outcome && ...)`. So when the acceptance probe threw, all three
 * guards were skipped and the repair was recorded as applied. The sequence was:
 *
 *     detect -> mutate -> verifier throws -> record success
 *
 * This is the same failure as a probe reporting an empty table it could not
 * read, moved one step later and made worse. There the system manufactured
 * certainty about the world; here it manufactures certainty about its own work,
 * after having already changed a customer's backend.
 *
 * A database timeout does not prove the repair failed. It also does not prove
 * it succeeded. There are three realities and the loop must keep them apart:
 *
 *   probe confirms the postcondition     CONFIRMED     record a verified repair
 *   probe runs, postcondition is false   FAILED        escalate, do not record
 *   probe cannot produce evidence        UNKNOWN       never claim success,
 *                                                      stop dependent work
 *
 * ── Why these tests use a real database ───────────────────────────────────
 *
 * Because the claim is about the disagreement between what the ledger says and
 * what PostgreSQL contains, and only one of those can be mocked. The decisive
 * assertion below is a count from `pg_index`: it proves in one number both that
 * the mutation really happened and that the loop then STOPPED, which is the
 * half of this fix that is easy to leave out.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

/**
 * The injection point.
 *
 * Only `evaluateFixOutcome` is replaced; `computeDesiredStateDiff` and the rest
 * of the module stay real, because the reconciler needs them to find the gaps
 * in the first place. A test that mocked the whole module would be asserting
 * against a loop that never ran.
 */
let verifierMode: 'real' | 'throws' | 'unresolved' = 'real'

/**
 * A Proxy, not a spread.
 *
 * `{ ...jest.requireActual(...) }` evaluates the real module inside the mock
 * factory, which runs before the module graph has settled. `desired-state`
 * imports `workspace-observer`, which imports `subsystem-recurrence`, which
 * imports `desired-state` — a cycle Node resolves fine on its own and which
 * blows up with "Cannot access 'INVARIANTS' before initialization" when forced
 * early. Deferring every property read to access time lets the cycle resolve
 * exactly as it does in production.
 */
jest.mock('@/lib/autonomy/desired-state', () => {
  const load = () => jest.requireActual('@/lib/autonomy/desired-state') as Record<string, unknown>
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === '__esModule') return true
        if (prop === 'evaluateFixOutcome') {
          return async (...args: unknown[]) => {
            if (verifierMode === 'throws') {
              // The shape of the real thing: a connection dropped mid-probe.
              throw new Error('connection terminated unexpectedly')
            }
            if (verifierMode === 'unresolved') {
              return {
                recheck: 'unresolved',
                regressions: [],
                accepted: false,
                reason: 'the gap is still present on re-check',
              }
            }
            return (load().evaluateFixOutcome as (...a: unknown[]) => unknown)(...args)
          }
        }
        return load()[prop]
      },
    },
  )
})

import { runReconcilerLive, computeReconciliationPlan } from '@/lib/autonomy/reconciler'
import { executeApprovedFix } from '@/lib/core/auto-fix-engine'
import { buildTrustReport } from '@/lib/autonomy/trust-report'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let projectId: string
let planId: string
let schema: string

/** How many of this project's relationship columns actually carry an index. */
async function indexedColumnCount(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`
    SELECT count(*)::bigint AS n
      FROM pg_index i
      JOIN pg_class c   ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = '${schema}'
       AND NOT i.indisprimary
  `)
  return Number(rows[0]?.n ?? 0)
}

async function auditCount(action: string): Promise<number> {
  return prisma.auditLog.count({ where: { projectId, action } })
}

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `verify+${userId.slice(0, 8)}@backenly.test`,
      name: 'verification fixture',
      password: 'not-a-real-hash',
    },
  })

  const plan = await prisma.plan.create({
    data: {
      name: `VERIFY_${userId.slice(0, 8)}`,
      priceCents: 0,
      autonomyScanIntervalMin: 1,
      autonomyMaxLevel: 'AGGRESSIVE',
      autonomyMaxActionsPerWindow: null,
    } as any,
  })
  planId = plan.id
  await prisma.subscription.create({ data: { userId, planId, status: 'ACTIVE' } as any })

  await prisma.project.create({
    data: { id: projectId, name: 'verification-fixture', userId, autonomyLevel: 'AGGRESSIVE' } as any,
  })
  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}, 180_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.subscription.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.plan.deleteMany({ where: { id: planId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 180_000)

beforeEach(() => {
  verifierMode = 'real'
})

async function seedThreeUnindexedRelationships(prefix: string) {
  for (const t of [`${prefix}_a`, `${prefix}_b`, `${prefix}_c`]) {
    await q(`CREATE TABLE "${schema}"."${t}" (id uuid PRIMARY KEY, order_id uuid)`)
    await prisma.table.create({ data: { projectId, name: t, schema, description: 'fixture' } })
  }
}

// ── The bug ──────────────────────────────────────────────────────────────────

describe('when the acceptance probe throws after a successful mutation', () => {
  it('mutates the database, records no success, and stops the tick', async () => {
    await seedThreeUnindexedRelationships('vfail')

    const before = await computeReconciliationPlan(projectId)
    expect(
      before.decisions.filter(d => d.action === 'WOULD_AUTO_APPLY').length,
    ).toBeGreaterThanOrEqual(3)
    expect(await indexedColumnCount()).toBe(0)

    verifierMode = 'throws'
    const res = await runReconcilerLive(projectId)
    expect(res).not.toBeNull()

    // ── 1. The mutation really happened ──────────────────────────────────
    //
    // Ground truth from pg_index, not from the ledger. If this were 0 the
    // test would be asserting against a fix that never ran, and everything
    // below it would be vacuous.
    const indexes = await indexedColumnCount()
    expect(indexes).toBeGreaterThan(0)

    // ── 2. It stopped rather than carrying on ────────────────────────────
    //
    // Invariant 2, in one number. Three gaps were auto-eligible and the loop
    // applied EXACTLY ONE before halting, because everything it would do next
    // rests on state it could not confirm. Without the break this is 3.
    expect(indexes).toBe(1)

    // ── 3. Nothing claims the repair succeeded ───────────────────────────
    expect(res!.applied).toBe(0)
    expect(await auditCount('HEALTH_AUTO_FIXED')).toBe(0)
    expect(await auditCount('HEALTH_FIX_UNVERIFIED')).toBe(1)

    // ── 4. The finding does not disappear as healed ──────────────────────
    const healed = await prisma.healthFinding.count({
      where: { projectId, status: 'auto_fixed' },
    })
    expect(healed).toBe(0)

    // Located via the audit row rather than by status. The project carries
    // other pending_approval findings (tier-2 gaps nobody has approved), so
    // `findFirst({ status })` would assert against whichever one came back.
    const auditRow = await prisma.auditLog.findFirst({
      where: { projectId, action: 'HEALTH_FIX_UNVERIFIED' },
      select: { details: true },
    })
    expect(auditRow).not.toBeNull()
    const auditDetails = JSON.parse(auditRow!.details as string) as Record<string, any>
    expect(auditDetails.verification).toBe('verification_error')
    expect(auditDetails.verifierError).toMatch(/connection terminated/)

    const unverified = await prisma.healthFinding.findUnique({
      where: { id: auditDetails.findingId as string },
      select: { status: true, details: true },
    })
    expect(unverified).not.toBeNull()
    expect(unverified!.status).toBe('pending_approval')
    const det = unverified!.details as Record<string, any>
    // The mutation is on the record even though the verdict is not, so a later
    // reader can tell "we changed this and do not know" from "we never ran".
    expect(det.appliedUnverified).toBeTruthy()
    expect(det.appliedUnverified.verifierError).toMatch(/connection terminated/)

    // ── 5. The trust scoreboard does not count it ────────────────────────
    const report = await buildTrustReport(projectId, 30)
    expect(report.scoreboard.autonomousFixes).toBe(0)
    // Not 100%. `verifiedRate` divides confirmed by autonomous fixes, and an
    // unverified mutation must not appear in either half.
    expect(report.scoreboard.verifiedRate === null || report.scoreboard.verifiedRate === 0).toBe(
      true,
    )
    expect(report.appliedChanges.every(c => c.verified === false)).toBe(true)
  }, 300_000)
})

// ── Unknown is not permission to mutate again ────────────────────────────────

describe('after a verification error, the same repair cannot just run again', () => {
  it('re-observes first, and closes the finding instead of re-mutating', async () => {
    // The reachable sequence this guards: the index was created, the check
    // timed out, the finding stayed in the queue, and the owner opens Autonomy
    // ten seconds later and clicks Approve & fix.
    const audit = await prisma.auditLog.findFirst({
      where: { projectId, action: 'HEALTH_FIX_UNVERIFIED' },
      select: { details: true },
    })
    expect(audit).not.toBeNull()
    const findingId = (JSON.parse(audit!.details as string) as Record<string, any>)
      .findingId as string

    const before = await indexedColumnCount()

    // The verifier works again by now — which is the whole point. A fresh
    // observation is what unlocks the decision.
    verifierMode = 'real'
    const res = await executeApprovedFix(findingId, projectId)

    // Nothing was applied a second time. `CREATE INDEX IF NOT EXISTS` would
    // have made a repeat invisible in the catalog, so the assertion that
    // matters is that the engine SAID it did not re-run, alongside the count.
    expect(await indexedColumnCount()).toBe(before)
    expect(res.success).toBe(true)
    expect(res.message).toMatch(/already fixed/i)
    expect(res.verification).toBe('confirmed')

    // And it is now recorded as the verified repair it turned out to be,
    // rather than staying in the queue forever.
    const finding = await prisma.healthFinding.findUnique({
      where: { id: findingId },
      select: { status: true, details: true },
    })
    expect(finding!.status).toBe('auto_fixed')
    const rb = (finding!.details as Record<string, any>).rollbackData
    expect(rb.verification).toBe('confirmed')
    expect(rb.confirmedLate).toBe(true)
    // Undo still works: the statements and snapshot from the original run were
    // carried forward rather than lost with the unverified record.
    expect(rb.statements).toBeDefined()
  }, 300_000)
})

// ── The two realities it must stay distinct from ─────────────────────────────

describe('a probe that runs and reports the fix did not hold', () => {
  it('escalates as a failed repair, which is a different claim from cannot-verify', async () => {
    await seedThreeUnindexedRelationships('vunres')

    verifierMode = 'unresolved'
    await runReconcilerLive(projectId)

    // Escalated, NOT recorded as applied-unverified. The probe produced
    // evidence; it just was not the evidence we wanted.
    expect(await auditCount('HEALTH_FIX_ESCALATED')).toBeGreaterThan(0)
    expect(await auditCount('HEALTH_FIX_UNVERIFIED')).toBe(1) // still just the one from the test above
  }, 300_000)
})

describe('a probe that confirms the postcondition', () => {
  it('still records a verified repair — the happy path is intact', async () => {
    await seedThreeUnindexedRelationships('vok')

    verifierMode = 'real'
    const res = await runReconcilerLive(projectId)
    expect(res).not.toBeNull()

    // The inverse of the first test. Without this, every assertion above could
    // be passing because the loop had stopped repairing anything at all.
    expect(res!.applied).toBeGreaterThan(0)
    expect(await auditCount('HEALTH_AUTO_FIXED')).toBeGreaterThan(0)

    const report = await buildTrustReport(projectId, 30)
    expect(report.scoreboard.autonomousFixes).toBeGreaterThan(0)
  }, 300_000)
})
