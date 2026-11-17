/**
 * A FUNCTION WRITTEN WITH @backenly/functions DEPLOYS AND ANSWERS
 * ================================================================
 *
 * Production QA re-test 2026-11-16, #44: an http function had to import
 * next/server, @/lib/db, @/lib/auth/jwt and @/lib/auth/session, paths inside
 * Backenly's own source tree. Function code now imports Backenly's helpers from
 * one module, @backenly/functions, and answers with the Web Response.
 *
 * Here functions are deployed through deploy_code (validated in the function
 * runner, as an agent's are) and called at /api/v1/{projectId}/fn/{name}
 * through the real runtime, with a real API key, against real tables with
 * row-level security on the project's own function login. A function written
 * with the old paths is deployed and called the same way, and still answers.
 */

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import * as jsonwebtoken from 'jsonwebtoken'
import { Client } from 'pg'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { deployFunctionCode } from '@/lib/services/ai-functions/agent-actions'
import { deriveProjectAdminKey } from '@/lib/services/ai-functions/project-fn-auth'
import { forgetFunctionDbClient, functionRoleName } from '@/lib/services/ai-functions/function-db-role'

jest.setTimeout(120_000)

const jwt: typeof jsonwebtoken = (jsonwebtoken as any).default ?? jsonwebtoken
const SECRET = 'functions-module-secret-not-a-real-one'
let ownerId = ''
let projectId = ''
let apiKey = ''
let server: http.Server
let base = ''
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

/** A token this project signed for one of its users. */
const tokenFor = (userId: string) => jwt.sign({ userId }, SECRET, { algorithm: 'HS256' })

/** POST /api/v1/{projectId}/fn/{name} through the runtime, as an app calls it. */
async function callFn(name: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1/${projectId}/fn/${name}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, type: res.headers.get('content-type') ?? '', cache: res.headers.get('cache-control'), text: await res.text() }
}

const deploy = (name: string, code: string) => deployFunctionCode({ userId: ownerId, projectId }, { name, code, trigger: 'http' })

// The shopper's orders as the shopper, and how many there are in all, which
// only the service role may count.
const myOrders = `
  import { db, asService, verifyToken } from '@backenly/functions'

  export async function POST(request: Request) {
    const raw = request.headers.get('x-user-token') || request.headers.get('authorization') || ''
    const caller = verifyToken(raw.replace(/^Bearer /i, ''))
    if (!caller) return Response.json({ error: 'Sign in first' }, { status: 401 })
    const mine = await db.$queryRawUnsafe('SELECT item FROM orders ORDER BY id')
    const [all] = await asService((tx) => tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM orders'))
    return Response.json(
      { caller: caller.userId, mine: mine.map((r) => r.item), all: all.n },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    )
  }
`

// The same function, written with the paths functions imported before.
const myOrdersBefore = `
  import { NextRequest, NextResponse } from 'next/server'
  import { prisma, asService } from '@/lib/db'
  import { verifyToken } from '@/lib/auth/jwt'

  export async function POST(request: NextRequest) {
    const raw = request.headers.get('x-user-token') || request.headers.get('authorization') || ''
    const caller = verifyToken(raw.replace(/^Bearer /i, ''))
    if (!caller) return NextResponse.json({ error: 'Sign in first' }, { status: 401 })
    const mine = await prisma.$queryRawUnsafe('SELECT item FROM orders ORDER BY id')
    const [all] = await asService((db) => db.$queryRawUnsafe('SELECT count(*)::int AS n FROM orders'))
    return NextResponse.json(
      { caller: caller.userId, mine: mine.map((r) => r.item), all: all.n },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    )
  }
`

// Signs in whichever user an admin names, as a support tool might.
const signInAs = `
  import { isAdminRequest, createSession } from '@backenly/functions'

  export async function POST(request: Request) {
    if (!isAdminRequest(request)) return Response.json({ error: 'Forbidden' }, { status: 403 })
    const { userId } = await request.json()
    return Response.json(await createSession(userId))
  }
`

const ping = `export async function POST() { return new Response('pong') }`

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  for (const file of ['scripts/setup-direct-access.sql', 'scripts/sql/function-roles.sql']) {
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', file, '-d', process.env.TEST_DATABASE_URL!], { stdio: 'pipe' })
  }
  ownerId = (await prisma.user.create({ data: { email: `fn-module-${randomUUID()}@example.test`, name: 'owner' }, select: { id: true } })).id
  projectId = (await prisma.project.create({
    data: { name: `fn-module-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret: SECRET },
    select: { id: true },
  })).id
  const s = schema()
  await sql(`
    CREATE SCHEMA "${s}";
    CREATE TABLE "${s}".orders (id serial PRIMARY KEY, user_id text NOT NULL, item text NOT NULL);
    ALTER TABLE "${s}".orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "${s}".orders FORCE ROW LEVEL SECURITY;
    CREATE POLICY orders_own ON "${s}".orders FOR SELECT USING (user_id = ${sub} OR ${role} = 'service_role');
    INSERT INTO "${s}".orders (user_id, item) VALUES ('shopper-1', 'mug'), ('shopper-2', 'lamp'), ('shopper-1', 'pen');
    CREATE TABLE "${s}".users (id serial PRIMARY KEY, email text NOT NULL, password text NOT NULL);
    INSERT INTO "${s}".users (email, password) VALUES ('shopper@example.test', 'not-a-hash');
  `)
  apiKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'app',
      keyPrefix: apiKey.slice(0, 16),
      keyHash: hashApiKey(apiKey),
      permissions: ['read', 'write'],
      capabilities: [],
      userId: ownerId,
      projectId,
      keyType: 'public',
      scope: 'runtime',
      serviceRole: false,
      rateLimit: 1000,
    },
  })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  if (projectId) {
    await forgetFunctionDbClient(projectId).catch(() => {})
    await sql(`DROP SCHEMA IF EXISTS "${schema()}" CASCADE`).catch(() => {})
    const r = functionRoleName(schema())
    await sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
                 EXECUTE 'DROP OWNED BY ${r}'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$`).catch(() => {})
    await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('a function that imports only @backenly/functions and answers with Response.json', () => {
  it('deploys through deploy_code, which on main refuses the module', async () => {
    const r = await deploy('my-orders', myOrders)
    expect(r).toMatchObject({ ok: true, data: { name: 'my-orders', trigger: 'http' } })
    expect(r.summary).not.toContain('still work')
  })

  it('answers at /fn as its caller: its own rows through db, every row through asService, with its status and headers', async () => {
    const answer = await callFn('my-orders', {}, { 'x-user-token': `Bearer ${tokenFor('shopper-1')}` })
    expect(answer).toMatchObject({ status: 201, cache: 'no-store' })
    expect(answer.type).toMatch(/^application\/json/)
    expect(JSON.parse(answer.text)).toEqual({ caller: 'shopper-1', mine: ['mug', 'pen'], all: 3 })

    const signedOut = await callFn('my-orders', {})
    expect(signedOut.status).toBe(401)
    expect(JSON.parse(signedOut.text)).toEqual({ error: 'Sign in first' })
  })

  it('signs a user in with createSession, for a request with the project’s admin key only', async () => {
    expect(await deploy('sign-in-as', signInAs)).toMatchObject({ ok: true })

    expect((await callFn('sign-in-as', { userId: 1 })).status).toBe(403)

    const answer = await callFn('sign-in-as', { userId: 1 }, { 'x-admin-key': deriveProjectAdminKey(SECRET) })
    expect(answer.status).toBe(200)
    const session = JSON.parse(answer.text)
    expect(session.user).toMatchObject({ id: 1, email: 'shopper@example.test' })
    expect(jwt.verify(session.token, SECRET)).toMatchObject({ userId: 1, email: 'shopper@example.test', projectId })
  })

  it('answers with the text of a text Response, as written', async () => {
    expect(await deploy('ping', ping)).toMatchObject({ ok: true })
    const answer = await callFn('ping', {})
    expect(answer).toMatchObject({ status: 200, text: 'pong' })
    expect(answer.type).toMatch(/^text\/plain/)
  })
})

describe('a function written with the paths functions imported before', () => {
  it('deploys, and the receipt names the module to use from now on', async () => {
    const r = await deploy('my-orders-before', myOrdersBefore)
    expect(r).toMatchObject({ ok: true })
    expect(r.summary).toContain(
      'It imports from next/server, @/lib/db, @/lib/auth/jwt, which still work; new code imports the same helpers from @backenly/functions and answers with Response.json',
    )
  })

  it('answers at /fn exactly as the same function written with @backenly/functions does', async () => {
    const headers = { 'x-user-token': `Bearer ${tokenFor('shopper-1')}` }
    const before = await callFn('my-orders-before', {}, headers)
    const now = await callFn('my-orders', {}, headers)
    expect(before).toEqual(now)
    expect(JSON.parse(before.text)).toEqual({ caller: 'shopper-1', mine: ['mug', 'pen'], all: 3 })
  })
})
