/**
 * A backend the builder just finished must not have findings filed against it.
 *
 * This is the load-bearing trust invariant of the whole product: Backenly tells
 * an agent "done ✓", and then the autonomy loop must have nothing to say about
 * what it just built. A platform that ships a backend and immediately reports
 * `critical | missing_rls` against its own output is not demonstrating vigilance
 * — it is publishing its own build defect as the owner's problem, on a project
 * with zero users that has never been deployed.
 *
 * ── The defect this locks out ────────────────────────────────────────────────
 *
 * Ownership is not knowable at the moment a table is created. Agents emit
 * children before parents constantly — `order_items` before `orders` — so when
 * `autoApplyRlsIfNeeded` ran inside create_table there was no FK to `orders`
 * yet, `inferRlsPlan` correctly answered `undecidable`, and the table was left
 * with RLS OFF by design. One step later `orders` arrives,
 * `repairForeignKeysGlobally` installs the very FK that makes the child
 * decidable — and nothing re-asked the question. `reconcileAutoRls` exists for
 * exactly this and had ZERO callers in the repo, so the retroactive half of the
 * design never ran in any environment.
 *
 * Measured before the fix: this build produced `critical | missing_rls` on
 * `order_items`, and `order_items` was genuinely readable by any API key.
 *
 * ── Why it drives the real executor ─────────────────────────────────────────
 *
 * The gap was invisible to every existing test because each half is correct on
 * its own. `autoApplyRlsIfNeeded` is right to decline an undecidable table;
 * `detectMissingRls` is right to report an exposed one. Only the SEQUENCE is
 * wrong, so a test that mocks either side proves nothing. Everything here goes
 * through `executeAction` — the same kernel MCP tools, the dashboard, the
 * Supabase importer and the migration parser all funnel through.
 *
 * The table order below is the point of the fixture. Do not "tidy" it into
 * dependency order — creating parents first is the case that already worked.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { executeAction } from '@/lib/ai/minimal-executor'
import { detectMissingRls, detectRlsDeniesEverything } from '@/lib/services/workspace-observer'
import { checkAuthIntegrity, detectFkColumnsMissingConstraints } from '@/lib/core/drift-detector'

const prisma = new PrismaClient()

let projectId: string
let userId: string
let schema: string

const q = (sql: string) => prisma.$executeRawUnsafe(sql)

const create = (tableName: string, columns: Array<{ name: string; type: string }>) =>
  executeAction(
    { action: 'CREATE_TABLE', params: { tableName, columns, confirmed: true } } as any,
    projectId,
    undefined,
    0,
    undefined,
    false, // never replan — replanning calls a model, and this must stay deterministic
  )

async function rlsOf(table: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ enabled: boolean; policies: bigint }>>(
    `SELECT pc.relrowsecurity AS enabled,
            (SELECT count(*) FROM pg_policies p
              WHERE p.schemaname = $1 AND p.tablename = $2) AS policies
       FROM pg_class pc
       JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = $1
      WHERE pc.relname = $2`,
    schema,
    table,
  )
  return { enabled: rows[0]?.enabled ?? false, policies: Number(rows[0]?.policies ?? 0) }
}

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `born-clean+${userId.slice(0, 8)}@backenly.test`,
      name: 'fresh build fixture',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({ data: { id: projectId, name: 'born-clean', userId } })
  await prisma.workspace.create({
    data: { projectId, userId, name: 'born-clean', postgresSchema: schema, databaseProvisioned: true },
  })
  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)

  // Mirror production exposure (scripts/sql/postgrest-ddl-sync.sql): every table
  // in a workspace schema is reachable by anon/authenticated the moment it
  // exists. Without this an un-RLS'd table is not actually exposed, the
  // reachability clause in detectMissingRls never matches, and the fixture would
  // pass for the wrong reason.
  await q(`GRANT USAGE ON SCHEMA "${schema}" TO anon, authenticated`).catch(() => {})
  await q(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated`,
  ).catch(() => {})
  await q(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT ON TABLES TO anon`).catch(() => {})
}, 180_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  for (const fn of [
    () => prisma.healthFinding.deleteMany({ where: { projectId } }),
    () => prisma.table.deleteMany({ where: { projectId } }),
    () => prisma.auditLog.deleteMany({ where: { projectId } }),
    () => prisma.permissionPolicy.deleteMany({ where: { projectId } }),
    () => prisma.workspace.deleteMany({ where: { projectId } }),
    () => prisma.project.deleteMany({ where: { id: projectId } }),
    () => prisma.user.deleteMany({ where: { id: userId } }),
  ])
    await fn().catch(() => {})
  await prisma.$disconnect()
}, 180_000)

describe('a backend the builder just finished', () => {
  it('builds, child-before-parent, the way an agent actually emits tables', async () => {
    // products: reference data, decidable immediately → public_read
    expect((await create('products', [
      { name: 'title', type: 'TEXT' },
      { name: 'price_cents', type: 'INTEGER' },
    ])).success).toBe(true)

    // order_items: the child. At THIS instant `orders` does not exist, so
    // ownership is genuinely undecidable and RLS is correctly left off.
    expect((await create('order_items', [
      { name: 'order_id', type: 'UUID' },
      { name: 'product_id', type: 'UUID' },
      { name: 'quantity', type: 'INTEGER' },
    ])).success).toBe(true)

    // orders: the parent arriving late. Creating it installs
    // order_items.order_id → orders.id, which is what makes the child decidable.
    expect((await create('orders', [
      { name: 'user_id', type: 'UUID' },
      { name: 'total_cents', type: 'INTEGER' },
      { name: 'status', type: 'TEXT' },
    ])).success).toBe(true)
  }, 180_000)

  it('leaves NO table reachable with RLS disabled', async () => {
    const findings = await detectMissingRls(projectId)
    expect(
      findings.map((f) => `${f.severity} ${f.type} ${(f.details as any)?.tableName}`),
    ).toEqual([])
  }, 120_000)

  it('protected the late-decidable child through its parent, not by guessing', async () => {
    const state = await rlsOf('order_items')
    expect(state.enabled).toBe(true)
    expect(state.policies).toBeGreaterThan(0)

    // The policy must be the INHERITED one (related_rows via orders.user_id).
    // An own_rows policy here would mean it invented an owner column, and a
    // deny-all would mean it traded an exposure for an outage. The template is
    // carried in policyName (`backenly_<template>`) — PermissionPolicy has no
    // `template` column.
    const policy = await prisma.permissionPolicy.findFirst({
      where: { projectId, tableName: 'order_items', enabled: true },
      select: { policyName: true, using: true },
    })
    expect(policy?.policyName).toBe('backenly_related_rows')
    // and it resolves ownership by hopping to the parent, not by reading a
    // column `order_items` does not have.
    expect(policy?.using).toContain('orders')
  }, 120_000)

  it('did not trade the exposure for an outage anywhere', async () => {
    // RLS on with zero policies reads EMPTY to every client while the API still
    // answers 200 — a worse bug than the one being fixed.
    const findings = await detectRlsDeniesEverything(projectId)
    expect(findings.map((f) => (f.details as any)?.tableName)).toEqual([])
  }, 120_000)

  it('files nothing else against its own fresh output either', async () => {
    // The whole point is zero, not "zero of the one type we fixed".
    const [auth, fks] = await Promise.all([
      checkAuthIntegrity(projectId),
      detectFkColumnsMissingConstraints(projectId),
    ])
    expect(auth.map((f) => `${f.type}:${(f.details as any)?.tableName ?? ''}`)).toEqual([])
    expect(fks.map((f) => `${f.type}:${(f.details as any)?.tableName ?? ''}`)).toEqual([])
  }, 120_000)

  it('does not re-rule the end-user identity table out from under auth', async () => {
    // The reconcile sweep this fix activates had zero callers before, so nothing
    // had ever exercised it against `users`. `users` IS decidable
    // (inferRlsPlanFromCatalog owns it to its own `id`), so the sweep will act on
    // it unless a PermissionPolicy row already claims it. `ensureUsersRlsPolicy`
    // installs exactly the same own_rows-on-`id` rule, so the two converge — but
    // "they happen to agree today" is the kind of thing that silently stops being
    // true, and getting it wrong locks every end-user out of their own account.
    await q(`
      CREATE TABLE IF NOT EXISTS "${schema}"."users" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text UNIQUE NOT NULL,
        password text,
        "createdAt" timestamptz DEFAULT now()
      )`)

    const { reconcileAutoRls } = await import('@/lib/services/workspace-rls')
    await reconcileAutoRls(projectId)

    const policy = await prisma.permissionPolicy.findFirst({
      where: { projectId, tableName: 'users', enabled: true },
      select: { policyName: true, using: true },
    })
    expect(policy?.policyName).toBe('backenly_own_rows')
    // Keyed on the table's OWN primary key. Anything else (a `user_id` column it
    // does not have) would deny every row to every caller.
    expect(policy?.using).toContain('id')

    const state = await rlsOf('users')
    expect(state.enabled).toBe(true)
    expect(state.policies).toBeGreaterThan(0)
  }, 120_000)

  it('still protects a table whose owner column arrives via ADD_COLUMN', async () => {
    // The same asymmetry, one step later in a project's life. create_table was
    // the only path that had ever applied RLS, so a table that became ownable
    // through a later column stayed unprotected forever.
    await q(`CREATE TABLE "${schema}"."saved_carts" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text)`)
    expect((await rlsOf('saved_carts')).enabled).toBe(false)

    const res = await executeAction(
      {
        action: 'ADD_COLUMN',
        params: { tableName: 'saved_carts', columnName: 'user_id', columnType: 'UUID', confirmed: true },
      } as any,
      projectId,
      undefined,
      0,
      undefined,
      false,
    )
    expect(res.success).toBe(true)

    const state = await rlsOf('saved_carts')
    expect(state.enabled).toBe(true)
    expect(state.policies).toBeGreaterThan(0)
    expect(await detectMissingRls(projectId)).toEqual([])
  }, 180_000)
})
