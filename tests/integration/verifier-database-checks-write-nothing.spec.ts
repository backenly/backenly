/**
 * Backenly's database checks (lib/ai/behavioral-verifier.ts: CRUD lifecycle,
 * auth flow, RLS isolation) write their test rows inside a transaction that is
 * always rolled back, so a verification leaves nothing in the customer's
 * database and starts nothing.
 *
 * They used to commit each test row and delete it afterwards. Each committed
 * write was a real change: it was captured for the customer's row-event
 * functions and webhooks (production QA re-test, 2026-11-16, N1: a run left two
 * captured changes carrying Backenly's test rows), and the customer's own
 * triggers kept what they wrote after the test row was deleted.
 *
 * Real provisioned project, real users table, capture triggers and outbox, the
 * customer's own triggers, and the real verifier.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { runBehavioralVerification, type BehavioralVerificationResult } from '@/lib/ai/behavioral-verifier'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { OUTBOX_TABLE, syncWebhookCapture } from '@/lib/webhooks/capture'

let ownerId: string
let projectId: string
let schema: string
let result: BehavioralVerificationResult
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

const q = (name: string) => `"${schema}"."${name}"`

async function count(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${q(table)}`)
  return rows[0].n
}

const check = (id: string) => result.checks.find((c) => c.id === id)!

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  // Nothing listens here, so the live HTTP check skips rather than signing anyone up.
  process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:9'

  const email = `db-checks-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'Database checks' } })).id
  const project = await createProvisionedProject({ name: 'db-checks-write-nothing', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema

  await prisma.$executeRawUnsafe(jwtClaimFunctionSql(schema))
  await ensureAuthUsersTable(projectId, { email })

  // The customer's own trigger: a profile row for each new user.
  await prisma.$executeRawUnsafe(`CREATE TABLE ${q('profiles')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`)
  await prisma.$executeRawUnsafe(`CREATE FUNCTION ${q('create_profile')}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO ${q('profiles')} (user_id) VALUES (NEW.id::text);
      RETURN NULL;
    END $$`)
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER create_profile AFTER INSERT ON ${q('users')} FOR EACH ROW EXECUTE FUNCTION ${q('create_profile')}()`,
  )

  // QA's orders, owned by the signed-in user, with Backenly's own-rows policy,
  // a function that runs on new orders, and the customer's audit trigger.
  await prisma.$executeRawUnsafe(`CREATE TABLE ${q('orders')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL DEFAULT (${q('backenly_jwt_claim')}('sub'))::uuid,
    customer_email text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipped')),
    total_cents integer NOT NULL
  )`)
  await prisma.table.create({ data: { name: 'orders', projectId } })
  await prisma.$executeRawUnsafe(`ALTER TABLE ${q('orders')} ENABLE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(
    `CREATE POLICY backenly_own_rows ON ${q('orders')} USING (user_id::text = ${q('backenly_jwt_claim')}('sub'))`,
  )
  await prisma.$executeRawUnsafe(`CREATE TABLE ${q('order_audit')} (
    id bigserial PRIMARY KEY,
    op text NOT NULL,
    order_id uuid,
    at timestamptz NOT NULL DEFAULT now()
  )`)
  await prisma.$executeRawUnsafe(`CREATE FUNCTION ${q('audit_order')}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO ${q('order_audit')} (op, order_id) VALUES (TG_OP, OLD.id);
      ELSE
        INSERT INTO ${q('order_audit')} (op, order_id) VALUES (TG_OP, NEW.id);
      END IF;
      RETURN NULL;
    END $$`)
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER audit_order AFTER INSERT OR UPDATE OR DELETE ON ${q('orders')} FOR EACH ROW EXECUTE FUNCTION ${q('audit_order')}()`,
  )
  await prisma.aiFunction.create({
    data: {
      projectId,
      name: 'order-created',
      description: 'order-created',
      generatedCode: 'return { ok: true }',
      codeOrigin: 'agent',
      triggerType: 'on_db_insert',
      triggerTable: 'orders',
      status: 'active',
    },
  })
  await syncWebhookCapture(projectId)

  result = await runBehavioralVerification(projectId)
}, 180_000)

afterAll(async () => {
  const schemas = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}%'`,
  ).catch(() => [])
  for (const s of schemas) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s.nspname}" CASCADE`).catch(() => {})
  await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
  process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
}, 120_000)

describe("Backenly's database checks", () => {
  it('still run: CRUD and the auth flow pass, and the RLS check runs on orders', () => {
    expect(check('crud_lifecycle').error).toBeUndefined()
    expect(check('crud_lifecycle')).toMatchObject({ passed: true, skipped: false })
    expect(check('auth_flow').error).toBeUndefined()
    expect(check('auth_flow')).toMatchObject({ passed: true, skipped: false })
    // Its verdict is not asserted: the test database connects as a superuser,
    // which row-level security never applies to, so user B always sees the row.
    expect(check('rls_isolation').skipped).toBe(false)
    expect(check('rls_isolation').details[0]).toMatch(/^✓ User A \(.+\) inserted row id=/)
    expect(check('trigger_execution')).toMatchObject({ passed: true })
  })

  it('leave no captured change for a function or a webhook to run on', async () => {
    expect(await count(OUTBOX_TABLE)).toBe(0)
  })

  it("leave no test row, and nothing the table's own trigger wrote for one", async () => {
    expect(await count('orders')).toBe(0)
    expect(await count('order_audit')).toBe(0)
  })

  it('leave no test user, and no profile the users table made for one', async () => {
    expect(await count('users')).toBe(0)
    expect(await count('profiles')).toBe(0)
  })
})
