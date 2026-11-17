/**
 * Backenly's check of row-event functions (lib/ai/behavioral-verifier.ts,
 * `trigger_execution`, a blocking part of publishing) proves that a row change
 * reaches each function that runs on it, and writes nothing doing it.
 *
 * Production QA re-test, 2026-11-16, N1: publishing was blocked by "Trigger/
 * function execution … Required value missing — a NOT NULL column was inserted
 * without a value." The check's test row left out the owner column, whose
 * default reads the signed-in user, and it ran as nobody. Before that, every
 * row it did write was captured like any other, so the project's own functions
 * ran on Backenly's test rows.
 *
 * Real provisioned project, real capture triggers and outbox, real verifier.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { runBehavioralVerification, type BehavioralCheck } from '@/lib/ai/behavioral-verifier'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { OUTBOX_TABLE, syncWebhookCapture } from '@/lib/webhooks/capture'

let ownerId: string
let projectId: string
let schema: string
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

const q = (name: string) => `"${schema}"."${name}"`

async function count(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${q(table)}`)
  return rows[0].n
}

/** The project's row-event functions are exactly these, with row capture synced to them. */
async function functions(
  ...fns: Array<{ name: string; triggerType: string; table: string; watches?: string[] }>
): Promise<void> {
  await prisma.aiFunction.deleteMany({ where: { projectId } })
  for (const f of fns) {
    const row = await prisma.aiFunction.create({
      data: {
        projectId,
        name: f.name,
        description: f.name,
        generatedCode: 'return { ok: true }',
        codeOrigin: 'agent',
        triggerType: f.triggerType,
        triggerTable: f.table,
        status: 'active',
      },
    })
    if (f.watches) await prisma.aiFunctionTriggerColumns.create({ data: { functionId: row.id, columns: f.watches } })
  }
  await syncWebhookCapture(projectId)
}

async function rowEventCheck(): Promise<{ check: BehavioralCheck; verdict: string }> {
  const result = await runBehavioralVerification(projectId)
  return { check: result.checks.find((c) => c.id === 'trigger_execution')!, verdict: result.verdict }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  // Nothing listens here, so the live HTTP check skips rather than signing anyone up.
  process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:9'

  const email = `row-event-check-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'Row event check' } })).id
  const project = await createProvisionedProject({ name: 'row-event-check', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema

  await prisma.$executeRawUnsafe(jwtClaimFunctionSql(schema))
  // QA's orders: the owner column defaults to the signed-in user.
  await prisma.$executeRawUnsafe(`CREATE TABLE ${q('orders')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL DEFAULT (${q('backenly_jwt_claim')}('sub'))::uuid,
    customer_email text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipped')),
    total_cents integer NOT NULL,
    shipped_at timestamptz
  )`)
  await prisma.$executeRawUnsafe(`CREATE TABLE ${q('notes')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    body text NOT NULL
  )`)
  // No value Backenly would choose satisfies this, so no test row can be built.
  await prisma.$executeRawUnsafe(`CREATE TABLE ${q('ledger')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    amount_cents integer NOT NULL CHECK (amount_cents > 1000)
  )`)
}, 180_000)

afterAll(async () => {
  const schemas = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}%'`,
  ).catch(() => [])
  for (const s of schemas) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s.nspname}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
  process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
}, 120_000)

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM ${q(OUTBOX_TABLE)}`).catch(() => {})
})

describe('the check of row-event functions', () => {
  it("passes for functions on a table whose owner column defaults to the signed-in user", async () => {
    await functions(
      { name: 'order-created', triggerType: 'on_db_insert', table: 'orders' },
      { name: 'order-shipped-email', triggerType: 'on_db_update', table: 'orders', watches: ['status'] },
      { name: 'order-removed', triggerType: 'on_db_delete', table: 'orders' },
    )
    const { check, verdict } = await rowEventCheck()
    expect(check.error).toBeUndefined()
    expect(check).toMatchObject({ passed: true, skipped: false })
    expect(verdict).not.toBe('failed')
    // Every function, each with the change it runs on.
    expect(check.details).toEqual([
      '✓ order-created: a new row in "orders" reaches it',
      '✓ order-removed: a deleted row in "orders" reaches it',
      '✓ order-shipped-email: a row update in "orders" reaches it',
    ])
  }, 120_000)

  it('writes nothing: no test row, and no captured change for a function or a webhook to run on', async () => {
    await functions({ name: 'note-created', triggerType: 'on_db_insert', table: 'notes' })
    const { check } = await rowEventCheck()
    expect(check).toMatchObject({ passed: true })
    expect(await count(OUTBOX_TABLE)).toBe(0)
    expect(await count('notes')).toBe(0)
  }, 120_000)

  it('says it could not check a function whose row it cannot build, and does not block publishing', async () => {
    await functions({ name: 'ledger-audit', triggerType: 'on_db_insert', table: 'ledger' })
    const { check, verdict } = await rowEventCheck()
    expect(check).toMatchObject({ passed: false, skipped: true })
    expect(check.skipReason).toMatch(/^Couldn't check ledger-audit: a test row could not be written to "ledger"/)
    expect(verdict).not.toBe('failed')
    expect(await count('ledger')).toBe(0)
  }, 120_000)

  it('fails when the change a function runs on is not captured', async () => {
    // Capture on notes for inserts only: an update there reaches nothing.
    await functions({ name: 'note-edited', triggerType: 'on_db_update', table: 'notes' })
    await prisma.$executeRawUnsafe(`DROP TRIGGER backenly_webhook_capture ON ${q('notes')}`)
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER backenly_webhook_capture AFTER INSERT ON ${q('notes')}
       FOR EACH ROW EXECUTE FUNCTION ${q('backenly_capture_webhook_event')}()`,
    )
    const { check, verdict } = await rowEventCheck()
    expect(check).toMatchObject({ passed: false, skipped: false })
    expect(check.error).toBe('note-edited: a row update in "notes" is not captured, so the function would not run')
    expect(verdict).toBe('failed')
  }, 120_000)
})
