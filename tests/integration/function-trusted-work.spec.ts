/**
 * A FUNCTION CAN DO TRUSTED WORK FOR ITS CALLER, AND ONLY IN ITS OWN PROJECT
 * ===========================================================================
 *
 * A route function's SQL runs as its caller, so row-level security keeps a
 * shopper to what a shopper may do. A checkout has to go further: create the
 * order and take the stock, and a shopper may not update products. There was
 * no way to: production QA's checkout answered "Your cart is empty", because
 * its SELECT … FOR UPDATE on products was filtered by the products UPDATE
 * policy, and the only service-role path was the caller sending the admin key,
 * which no shopper has (and which functions held in process.env).
 *
 * `asService(async (db) => …)` from '@/lib/db' runs a block in one transaction
 * as the service role. Real database, real function login (the project's own
 * role, which RLS applies to), real policies.
 */

import '@/tests/helpers/real-web-standard'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as jsonwebtoken from 'jsonwebtoken'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { AS_SERVICE_NOTE, executeRouteModuleFunction } from '@/lib/services/ai-functions/route-module-runner'
import { forgetFunctionDbClient, functionRoleName } from '@/lib/services/ai-functions/function-db-role'

jest.setTimeout(120_000)

const jwt: typeof jsonwebtoken = (jsonwebtoken as any).default ?? jsonwebtoken
const SECRET = 'trusted-work-function-secret-not-a-real-one'
let ownerId = ''
let projectId = ''
const schema = () => `workspace_${projectId}`

async function sql(text: string): Promise<any[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    return (await client.query(text)).rows
  } finally {
    await client.end().catch(() => {})
  }
}

const role = `(current_setting('request.jwt.claims', true)::json->>'role')`
const sub = `(current_setting('request.jwt.claims', true)::json->>'sub')`

beforeAll(async () => {
  for (const file of ['scripts/setup-direct-access.sql', 'scripts/sql/function-roles.sql']) {
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', file, '-d', process.env.TEST_DATABASE_URL!], { stdio: 'pipe' })
  }
  ownerId = (await prisma.user.create({ data: { email: `trusted-${randomUUID()}@example.test`, name: 'owner' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `trusted-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  const s = schema()
  await sql(`
    CREATE SCHEMA "${s}";
    CREATE TABLE "${s}".products (id int PRIMARY KEY, name text NOT NULL, stock int NOT NULL);
    ALTER TABLE "${s}".products ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "${s}".products FORCE ROW LEVEL SECURITY;
    CREATE POLICY products_read ON "${s}".products FOR SELECT USING (true);
    CREATE POLICY products_write ON "${s}".products FOR UPDATE USING (${role} = 'service_role');
    CREATE TABLE "${s}".orders (id serial PRIMARY KEY, user_id text NOT NULL, product_id int NOT NULL);
    ALTER TABLE "${s}".orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "${s}".orders FORCE ROW LEVEL SECURITY;
    CREATE POLICY orders_own ON "${s}".orders FOR SELECT USING (user_id = ${sub} OR ${role} = 'service_role');
    CREATE POLICY orders_create ON "${s}".orders FOR INSERT WITH CHECK (${role} = 'service_role');
    INSERT INTO "${s}".products VALUES (1, 'mug', 5);
  `)
})

afterAll(async () => {
  if (projectId) {
    await forgetFunctionDbClient(projectId).catch(() => {})
    await sql(`DROP SCHEMA IF EXISTS "${schema()}" CASCADE`).catch(() => {})
    const r = functionRoleName(schema())
    await sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
                 EXECUTE 'DROP OWNED BY ${r}'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$`).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

/** POST to a route function as a signed-in shopper. */
function asShopper(code: string, body: Record<string, unknown>) {
  const token = jwt.sign({ userId: 'shopper-1' }, SECRET, { algorithm: 'HS256' })
  return executeRouteModuleFunction(code, projectId, { type: 'http', data: body }, 'POST /fn/checkout', {
    authMaterial: { jwtSecret: SECRET, adminKey: null },
    headers: { 'x-user-token': `Bearer ${token}` },
  })
}

const checkout = `
  import { NextResponse } from 'next/server'
  import { prisma, asService } from '@/lib/db'
  import { verifyToken } from '@/lib/auth/jwt'

  export async function POST(request) {
    const caller = verifyToken((request.headers.get('x-user-token') || '').replace(/^Bearer /i, ''))
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { productId } = await request.json()
    // What the shopper may do themselves: their own lock on the product finds nothing.
    const seenByShopper = await prisma.$queryRawUnsafe('SELECT id FROM products WHERE id = $1 FOR UPDATE', productId)
    try {
      const order = await asService(async (db) => {
        const [product] = await db.$queryRawUnsafe('SELECT id, stock FROM products WHERE id = $1 FOR UPDATE', productId)
        if (!product || product.stock < 1) return null
        await db.$executeRawUnsafe('UPDATE products SET stock = stock - 1 WHERE id = $1', productId)
        const [row] = await db.$queryRawUnsafe('INSERT INTO orders (user_id, product_id) VALUES ($1, $2) RETURNING id, user_id', caller.userId, productId)
        return row
      })
      return NextResponse.json({ seenByShopper: seenByShopper.length, order })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }
`

it('takes the stock and creates the order for a shopper who may do neither, and says so in the run’s logs', async () => {
  const { returnValue, logs } = await asShopper(checkout, { productId: 1 })
  expect(returnValue).toMatchObject({ status: 200, body: { seenByShopper: 0, order: { id: expect.any(Number), user_id: 'shopper-1' } } })
  expect((await sql(`SELECT stock FROM "${schema()}".products WHERE id = 1`))[0].stock).toBe(4)
  expect(await sql(`SELECT user_id, product_id FROM "${schema()}".orders`)).toEqual([{ user_id: 'shopper-1', product_id: 1 }])
  expect(logs).toContain(AS_SERVICE_NOTE)
})

it('still reaches nothing outside the project’s own tables', async () => {
  const code = `
    import { NextResponse } from 'next/server'
    import { asService } from '@/lib/db'
    export async function POST() {
      try {
        const rows = await asService((db) => db.$queryRawUnsafe('SELECT count(*)::int AS n FROM public.projects'))
        return NextResponse.json({ rows })
      } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
      }
    }
  `
  const { returnValue } = await asShopper(code, {})
  expect(returnValue.status).toBe(500)
  expect(returnValue.body.error).toMatch(/permission denied/)
})

it('leaves the caller’s own queries as the caller', async () => {
  const code = `
    import { NextResponse } from 'next/server'
    import { prisma } from '@/lib/db'
    export async function POST() {
      try {
        await prisma.$executeRawUnsafe('UPDATE products SET stock = 0 WHERE id = 1')
        const [p] = await prisma.$queryRawUnsafe('SELECT stock FROM products WHERE id = 1')
        return NextResponse.json({ stock: p.stock })
      } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
      }
    }
  `
  const { returnValue, logs } = await asShopper(code, {})
  // The shopper's UPDATE matches no row the UPDATE policy admits: nothing changes.
  expect(returnValue).toMatchObject({ status: 200, body: { stock: 4 } })
  expect(logs).not.toContain(AS_SERVICE_NOTE)
})
