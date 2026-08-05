/**
 * A table Backenly generates must accept the row Backenly generates to fill it.
 *
 * ── The defect this locks out ────────────────────────────────────────────────
 *
 * `deriveConstraints` decided nullability from the column NAME:
 *
 *     isRequired: !lower.includes('optional') && !startsWith('is_'/'has_')
 *
 * Nothing an agent or a human writes names a column "optional", so in practice
 * EVERY scalar column came out NOT NULL with no default.
 *
 * Measured on a live project (`profiles`): display_name, avatar_url, role, bio,
 * website and location were all mandatory. Backenly then generated the signup
 * handler for that same table, and it correctly passed `avatar_url: null` for a
 * user who has not uploaded one. The table rejected the row its own generated
 * code was written to insert, with SQLSTATE 23502, once per minute for days
 * (the contract sweep's auth probe fires the signup handler). The function had
 * run 2,735 times, swallowed the error in its own try/catch, and reported
 * `status: active` with no lastError while `profiles` sat at ZERO rows.
 *
 * The same schema produced `billing_invoices.paid_at NOT NULL` (an unpaid
 * invoice is unrepresentable) and `apps.current_version_id NOT NULL` (an app
 * cannot exist before its first version, and the version cannot exist before
 * the app — neither row is insertable, ever).
 *
 * ── Why it asserts INSERTs, not DDL ─────────────────────────────────────────
 *
 * Reading `is_nullable` back out of information_schema would restate the
 * implementation. The property that actually matters to a user is "can a
 * realistic row go in", so every case below writes a real row through the same
 * catalog the runtime uses, and lets Postgres be the judge.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { executeAction } from '@/lib/ai/minimal-executor'

const prisma = new PrismaClient()

let projectId: string
let userId: string
let schema: string

const q = (sql: string) => prisma.$executeRawUnsafe(sql)

const create = (tableName: string, columns: any[]) =>
  executeAction(
    { action: 'CREATE_TABLE', params: { tableName, columns, confirmed: true } } as any,
    projectId,
    undefined,
    0,
    undefined,
    false,
  )

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `insertable+${userId.slice(0, 8)}@backenly.test`,
      name: 'insertable fixture',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({ data: { id: projectId, name: 'insertable', userId } })
  await prisma.workspace.create({
    data: { projectId, userId, name: 'insertable', postgresSchema: schema, databaseProvisioned: true },
  })
  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
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

describe('generated tables accept generated rows', () => {
  it('takes the exact signup payload Backenly writes for a profiles table', async () => {
    expect((await create('profiles', [
      { name: 'user_id', type: 'UUID' },
      { name: 'display_name', type: 'TEXT' },
      { name: 'avatar_url', type: 'TEXT' },
      { name: 'role', type: 'TEXT' },
      { name: 'bio', type: 'TEXT' },
      { name: 'website', type: 'TEXT' },
      { name: 'location', type: 'TEXT' },
    ])).success).toBe(true)

    // Byte-for-byte the shape on_signup_create_profile sends: a brand-new user
    // has no avatar, no bio, no website and no location.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "${schema}"."profiles"
           ("user_id","display_name","avatar_url","role","bio","website","location")
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)`,
        randomUUID(), 'Ada', null, 'user', null, null, null,
      ),
    ).resolves.toBe(1)
  }, 180_000)

  it('lets an invoice exist before it is paid', async () => {
    expect((await create('billing_invoices', [
      { name: 'amount', type: 'INTEGER' },
      { name: 'currency', type: 'TEXT' },
      { name: 'due_date', type: 'TIMESTAMP' },
      { name: 'paid_at', type: 'TIMESTAMP' },
    ])).success).toBe(true)

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "${schema}"."billing_invoices" ("amount","currency") VALUES ($1,$2)`,
        1000, 'usd',
      ),
    ).resolves.toBe(1)
  }, 180_000)

  it('lets a row exist before the row it will later point at', async () => {
    // apps.current_version_id → the deadlock: neither side can be inserted first
    // if the pointer is mandatory.
    expect((await create('apps', [
      { name: 'title', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'current_version_id', type: 'UUID' },
    ])).success).toBe(true)

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "${schema}"."apps" ("title") VALUES ($1)`,
        'First app',
      ),
    ).resolves.toBe(1)
  }, 180_000)

  it('still refuses a row that omits a column the caller REQUIRED', async () => {
    // Inference stops guessing; a stated `notNull` must still be enforced, or the
    // fix has simply moved the failure from "too strict" to "no constraints".
    expect((await create('contracts', [
      { name: 'title', type: 'TEXT', notNull: true },
      { name: 'notes', type: 'TEXT' },
    ])).success).toBe(true)

    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."contracts" ("notes") VALUES ($1)`, 'x'),
    ).rejects.toThrow()

    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."contracts" ("title") VALUES ($1)`, 'ok'),
    ).resolves.toBe(1)
  }, 180_000)

  it('still treats email as a required, unique identity anchor', async () => {
    expect((await create('members', [
      { name: 'email', type: 'TEXT' },
      { name: 'nickname', type: 'TEXT' },
    ])).success).toBe(true)

    // required
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."members" ("nickname") VALUES ($1)`, 'nick'),
    ).rejects.toThrow()

    // unique
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."members" ("email") VALUES ($1)`, 'a@b.test',
    )
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."members" ("email") VALUES ($1)`, 'a@b.test'),
    ).rejects.toThrow()
  }, 180_000)
})
