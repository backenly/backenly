/**
 * The two defects that made self-healing look real without being real.
 *
 * Both were found by running the loop against a live backend and then asking
 * PostgreSQL — not the audit log — whether anything had actually changed. Both
 * are invisible to a unit test that mocks the executor, so these assert against
 * a real schema and the real dispatcher.
 *
 *   1. THROUGHPUT. The autonomous path inherited `checkBuildBudget`, which
 *      enforces MAX_OPS_PER_HOUR = 10 and a 2-minute pause between mutations.
 *      Those pace AI builds. Inherited by the loop they became a hard ceiling of
 *      ten repairs per project per hour, so a backend with several gaps healed
 *      one every two minutes and logged `attempted=1 deferred=1` in between —
 *      which reads as a working loop on every surface that shows it. Worst on
 *      missing RLS, where the wait is an open security hole.
 *
 *   2. NOISE. `verifyStripeCheckout` was the only workflow with no "is this
 *      actually in use?" anchor, so a table named `orders` (or `payments`, or
 *      `subscriptions`) was enough to report a broken Stripe checkout on a
 *      project with no Stripe anything. That finding is classified `auto`, so
 *      the loop spent repairs on it, could never succeed, and eventually parked
 *      a nonsense row in the human queue.
 *
 * Each is asserted in BOTH directions. A quiet detector proves nothing unless
 * you also prove it still fires — that is the standard the rest of this
 * catalogue's fixtures hold themselves to, and the reason the stripe gate below
 * is tested with real evidence present as well as absent.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { verifyWorkflows } from '@/lib/core/workflow-verifier'
import { computeReconciliationPlan, runReconcilerLive } from '@/lib/autonomy/reconciler'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let projectId: string
let planId: string
let schema: string

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `throughput+${userId.slice(0, 8)}@backenly.test`,
      name: 'autonomy throughput fixture',
      password: 'not-a-real-hash',
    },
  })

  // Mirrors what seed-billing gives every tier: 1-minute cadence, AGGRESSIVE
  // ceiling, no per-window fix cap.
  const plan = await prisma.plan.create({
    data: {
      name: `THROUGHPUT_${userId.slice(0, 8)}`,
      priceCents: 0,
      autonomyScanIntervalMin: 1,
      autonomyMaxLevel: 'AGGRESSIVE',
      autonomyMaxActionsPerWindow: null,
    } as any,
  })
  planId = plan.id
  await prisma.subscription.create({ data: { userId, planId, status: 'ACTIVE' } as any })

  await prisma.project.create({
    data: { id: projectId, name: 'autonomy-throughput', userId, autonomyLevel: 'AGGRESSIVE' } as any,
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

// ── 1. Noise: the Stripe workflow needs Stripe evidence ─────────────────────

describe('verifyStripeCheckout — anchored on Stripe evidence, not on a table name', () => {
  it('stays SILENT for an orders table on a project with no Stripe anything', async () => {
    await q(`
      CREATE TABLE "${schema}"."orders" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        total numeric NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await prisma.table.create({
      data: { projectId, name: 'orders', schema, description: 'fixture' },
    })

    const stripe = (await verifyWorkflows(projectId)).filter(
      f => (f.details as any)?.workflow === 'stripe_checkout',
    )
    expect(stripe).toEqual([])
  }, 180_000)

  it('also stays silent for payments and subscriptions — the same three names', async () => {
    await q(`CREATE TABLE "${schema}"."payments" (id uuid PRIMARY KEY, amount numeric)`)
    await q(`CREATE TABLE "${schema}"."subscriptions" (id uuid PRIMARY KEY, plan text)`)

    const stripe = (await verifyWorkflows(projectId)).filter(
      f => (f.details as any)?.workflow === 'stripe_checkout',
    )
    expect(stripe).toEqual([])
  }, 180_000)

  it('FIRES once the project actually has a Stripe artifact — silence is not deafness', async () => {
    // A function named for Stripe is something the user built on purpose. That
    // IS evidence of intent, unlike a table called `orders`. Without this half
    // the gate above could be a detector that simply never fires.
    const fn = await prisma.aiFunction.create({
      data: {
        projectId,
        name: 'stripe_webhook_receiver',
        description: 'fixture — evidence the owner is building a Stripe flow',
        generatedCode: 'export default async function handler() {}',
        triggerType: 'manual',
        status: 'inactive',
      } as any,
    })

    const stripe = (await verifyWorkflows(projectId)).filter(
      f => (f.details as any)?.workflow === 'stripe_checkout',
    )
    expect(stripe.length).toBe(1)
    // And it names the thing the user must supply, rather than a table.
    expect((stripe[0].details as any).missingComponents).toContain('stripe_key')

    await prisma.aiFunction.delete({ where: { id: fn.id } })
  }, 180_000)
})

// ── 2. Throughput: a tick repairs a backend, not one gap of it ───────────────

describe('runReconcilerLive — converges a drifted backend without waiting out a build cooldown', () => {
  it('applies every auto-eligible gap in a single tick', async () => {
    // Several independent, unambiguously auto-fixable gaps: three unindexed
    // relationship columns. Under the inherited build budget the first fix
    // started a 2-minute cooldown and the rest deferred, so exactly one landed.
    for (const t of ['line_items', 'invoices', 'shipments']) {
      await q(`CREATE TABLE "${schema}"."${t}" (id uuid PRIMARY KEY, order_id uuid)`)
      await prisma.table.create({ data: { projectId, name: t, schema, description: 'fixture' } })
    }

    const before = await computeReconciliationPlan(projectId)
    const autoApplicable = before.decisions.filter(d => d.action === 'WOULD_AUTO_APPLY').length
    expect(autoApplicable).toBeGreaterThanOrEqual(3)

    const res = await runReconcilerLive(projectId)
    expect(res).not.toBeNull()

    // The claim under test: more than one repair in one pass. The old behaviour
    // was applied<=1 with the remainder deferred on the cooldown.
    expect(res!.applied).toBeGreaterThan(1)

    // Ground truth — ask the catalog, not the ledger. Every one of the three
    // order_id columns must now carry an index.
    const indexed = await prisma.$queryRawUnsafe<Array<{ tbl: string }>>(`
      SELECT c.relname AS tbl
      FROM pg_index i
      JOIN pg_class c     ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = '${schema}'
        AND c.relname IN ('line_items', 'invoices', 'shipments')
        AND a.attname = 'order_id'
    `)
    expect(new Set(indexed.map(r => r.tbl)).size).toBe(3)
  }, 300_000)

  it('never records a fix the database does not corroborate', async () => {
    // The trust guarantee, restated as an invariant over whatever the run above
    // produced: an index finding marked auto_fixed must have a real index.
    const claimed = await prisma.healthFinding.findMany({
      where: { projectId, status: 'auto_fixed', type: 'missing_fk_index' },
      select: { details: true },
    })

    for (const f of claimed) {
      const d = (f.details ?? {}) as any
      const table = d.tableName ?? d.table
      const column = d.columnName ?? d.column
      if (!table || !column) continue
      const hit = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`
        SELECT count(*)::bigint AS n
        FROM pg_index i
        JOIN pg_class c     ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = '${schema}' AND c.relname = '${table}' AND a.attname = '${column}'
      `)
      expect(Number(hit[0]?.n ?? 0)).toBeGreaterThan(0)
    }
  }, 180_000)
})
