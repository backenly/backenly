/**
 * A UNIQUE RULE NOBODY ASKED FOR, REFUSING WRITES
 * ------------------------------------------------
 * Production QA (2026-11-09): `orders` kept every email unique, which nobody
 * had asked for, so each customer's second order was refused with a conflict
 * while the loop reported every guarantee held.
 *
 * Same contract as the probe fixtures: build the state for real (tables, rules,
 * recorded requests), assert the probe fires on exactly what it should, then
 * assert it goes quiet once the rule is gone.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { detectRefusedWrites, REFUSED_MIN } from '@/lib/autonomy/refused-writes'
import { INVARIANTS } from '@/lib/autonomy/desired-state'
import { classifyFix } from '@/lib/core/fix-classifier'
import { getManualRemediationHint } from '@/lib/core/fix-actions'
import { summariseFinding } from '@/lib/core/finding-summaries'

let userId: string
let projectId: string
let schema: string
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000)
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

async function requests(path: string, method: string, statusCode: number, n: number, opts: { at?: Date; branchId?: string } = {}) {
  await prisma.apiRequestLog.createMany({
    data: Array.from({ length: n }, () => ({
      projectId,
      userId,
      method,
      path,
      statusCode,
      duration: 12,
      timestamp: opts.at ?? hoursAgo(1),
      branchId: opts.branchId ?? null,
    })),
  })
}

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `refused-${Date.now()}@example.test`, password: 'x', name: 'refused' } })).id
  projectId = (await prisma.project.create({ data: { name: 'refused-writes', userId } })).id
  schema = `workspace_${projectId}`
  await q(`CREATE SCHEMA "${schema}"`)
  // A rule nobody asked for, beside a composite one.
  await q(`CREATE TABLE "${schema}".orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, total int,
            CONSTRAINT orders_email_key UNIQUE (email), CONSTRAINT orders_email_total UNIQUE (email, total))`)
  // A rule someone asked for.
  await q(`CREATE TABLE "${schema}".coupons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE)`)
  await prisma.schemaIntent.create({ data: { projectId, tableName: 'coupons', columnName: 'code', requestedType: 'text', requestedUnique: true, source: 'create_table' } })
  // A unique index nobody asked for, scoped to live rows.
  await q(`CREATE TABLE "${schema}".carts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner text, deleted_at timestamptz)`)
  await q(`CREATE UNIQUE INDEX uniq_carts_owner ON "${schema}".carts (owner) WHERE deleted_at IS NULL`)
  // Sign-up's own table, and a table with a composite rule only.
  await q(`CREATE TABLE "${schema}".users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE)`)
  await q(`CREATE TABLE "${schema}".line_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, sku text, UNIQUE (order_id, sku))`)
  await q(`CREATE TABLE "${schema}".notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE)`)

  // orders: 12 of 22 writes refused, over both APIs.
  await requests('/db/orders', 'POST', 409, 10)
  await requests('/db/orders', 'POST', 201, 10)
  await requests('/orders', 'PATCH', 409, 2)
  // Refusals that must not count: reads, a branch, and last week.
  await requests('/db/orders', 'GET', 409, 30)
  await requests('/db/orders', 'POST', 409, 30, { branchId: 'branch-1' })
  await requests('/db/orders', 'POST', 409, 30, { at: hoursAgo(30) })
  // coupons: refused, but the rule was asked for.
  await requests('/db/coupons', 'POST', 409, 8)
  // carts: 5 of 25 refused.
  await requests('/carts', 'POST', 409, 5)
  await requests('/carts', 'POST', 201, 20)
  // users, line_items, and too few refusals on notes.
  await requests('/db/users', 'POST', 409, 20)
  await requests('/db/line_items', 'POST', 409, 9)
  await requests('/db/notes', 'POST', 409, REFUSED_MIN - 1)
}, 60_000)

afterAll(async () => {
  await prisma.apiRequestLog.deleteMany({ where: { projectId } })
  await prisma.schemaIntent.deleteMany({ where: { projectId } })
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await prisma.project.delete({ where: { id: projectId } })
  await prisma.user.delete({ where: { id: userId } })
})

describe('detectRefusedWrites', () => {
  test('names the unique rules nobody asked for on tables whose writes were refused', async () => {
    const findings = await detectRefusedWrites(projectId)
    const byLocation = Object.fromEntries(findings.map((f) => [f.details.location, f]))
    expect(Object.keys(byLocation).sort()).toEqual(['carts.owner', 'orders.email'])

    expect(byLocation['orders.email']).toMatchObject({
      type: 'unrequested_unique_refusing_writes',
      severity: 'critical',
      autoFixable: false,
      details: {
        tableName: 'orders',
        columnName: 'email',
        ruleName: 'orders_email_key',
        refused: 12,
        writes: 22,
        windowHours: 24,
        otherRules: ['email, total'],
        drop: 'ALTER TABLE orders DROP CONSTRAINT orders_email_key;',
      },
    })
    expect(byLocation['carts.owner']).toMatchObject({
      severity: 'warning',
      details: { refused: 5, writes: 25, ruleName: 'uniq_carts_owner', otherRules: [], drop: 'DROP INDEX uniq_carts_owner;' },
    })
  })

  test('goes quiet for a table once its rule is gone', async () => {
    await q(`ALTER TABLE "${schema}".orders DROP CONSTRAINT orders_email_key`)
    const findings = await detectRefusedWrites(projectId)
    expect(findings.map((f) => f.details.location)).toEqual(['carts.owner'])
  })
})

describe('what a person reads', () => {
  const details = {
    tableName: 'orders',
    columnName: 'email',
    location: 'orders.email',
    ruleName: 'orders_email_key',
    refused: 12,
    writes: 22,
    windowHours: 24,
    otherRules: ['email, total'],
    drop: 'ALTER TABLE orders DROP CONSTRAINT orders_email_key;',
  }

  test('a guarantee holds it, and the loop only tells', () => {
    expect(INVARIANTS.find((i) => i.id === 'no_unrequested_rule_refuses_writes')?.probe).toBe(detectRefusedWrites)
    expect(classifyFix('unrequested_unique_refusing_writes', details).decision).toBe('notify_only')
  })

  test('says what was refused, the likely rule, and both ways forward', () => {
    expect(summariseFinding('unrequested_unique_refusing_writes', details)).toBe(
      '`orders` refused 12 of 22 writes; `email` is kept unique by a rule nobody asked for',
    )
    expect(getManualRemediationHint('unrequested_unique_refusing_writes', details)).toBe(
      'orders refused 12 of its 22 writes in the last 24 hours with a conflict. orders.email is kept unique by a ' +
        'rule that nothing recorded for orders asked for. orders has other rules against repeated values too ' +
        '(email, total), so some refusals may be theirs.\n\nIf the same email can appear on more than one row, ask ' +
        'your coding agent to remove the rule with apply_migration:\n\n  ALTER TABLE orders DROP CONSTRAINT ' +
        'orders_email_key;\n\nIf it should stay unique, dismiss this: the refusals are the rule working.',
    )
  })
})
