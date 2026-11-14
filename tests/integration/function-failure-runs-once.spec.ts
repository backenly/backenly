/**
 * A FUNCTION THAT FAILS AFTER ITS CODE STARTED IS RUN ONCE (#606)
 * ==============================================================
 * The executor ran a failed sandbox run again, up to twice, when the error's
 * message looked transient. The retry ran the whole function, not the call
 * that failed, and the check matched the function's own outbound calls:
 * ctx.http goes through safeFetch, which rejects with Node's socket error
 * unchanged ("connect ECONNREFUSED …", "socket hang up"). So
 *
 *   await ctx.db.insert('orders', order)
 *   await ctx.integrations.email.send(receipt)
 *   await ctx.http.post(fulfilmentUrl, order)   // the fulfilment host is down
 *
 * inserted three orders and sent three receipts.
 *
 * Now the sandbox says when the function's code starts, and only a sandbox
 * that failed before then is started again. Here real function rows run in
 * real runner processes (executeAiFunction) against a real workspace table,
 * and ctx.http makes real connections: to a port nothing listens on, and to a
 * server that closes each connection without answering. Only Resend's reply
 * to the receipt is stubbed, at fetch, where it is counted. A sandbox that
 * fails to start is made by swapping in, when asked, a runner process that
 * can't be made or whose script can't load.
 */

const mockSandbox = { failures: [] as Array<'throw' | 'missing-script'>, starts: 0 }

// Each sandbox run is a runner process, started here as in development and
// tests (lib/services/ai-functions/isolation/client.ts). Each start is counted.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process')
  const nodePath = jest.requireActual('path')
  const isRunner = (arg: unknown) => /function-runner\.cjs$/.test(String(arg))
  return {
    ...actual,
    spawn(file: string, args: string[] = [], options?: unknown) {
      if (!Array.isArray(args) || !args.some(isRunner)) return actual.spawn(file, args, options)
      mockSandbox.starts++
      const failure = mockSandbox.failures.shift()
      if (failure === 'throw') throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
      // A runner whose script can't load comes up and fails before any code runs.
      const missing = nodePath.join(process.cwd(), 'tests', 'no-such-function-runner.cjs')
      return actual.spawn(file, failure === 'missing-script' ? args.map((a) => (isRunner(a) ? missing : a)) : args, options)
    },
  }
})

import crypto from 'crypto'
import net from 'net'
import { prisma } from '@/lib/db/prisma'
import { encrypt } from '@/lib/services/encryption'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

// The function's calls go to this machine's loopback, which customer code may
// reach only on a self-hosted install that allows it.
const EGRESS_ENV = 'BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE'
const ORIGINAL_EGRESS = process.env[EGRESS_ENV]
// A visibly synthetic key, built at runtime so no key-shaped literal sits in the repository.
const RESEND_KEY = `re_${'fn606'.repeat(5)}`

let userId = ''
let projectId = ''
let refusedUrl = ''
let droppedUrl = ''
let droppedConnections = 0
let dropper: net.Server
let receipts: string[] = []
let realFetch: typeof fetch

/** The function the issue describes: an order, its receipt, then the fulfilment call. */
const ORDER_THEN_FULFIL = `
  await ctx.db.insert('orders', { ref: event.data.ref })
  await ctx.integrations.email.send({
    to: 'buyer@example.test', from: 'shop@example.test', subject: 'Your receipt', text: 'Order ' + event.data.ref,
  })
  await ctx.http.post(event.data.fulfilmentUrl, { ref: event.data.ref })
  return { fulfilled: event.data.ref }
`

async function runFunction(name: string, code: string, data: Record<string, unknown>) {
  const fn = await prisma.aiFunction.create({
    data: { projectId, name, description: name, triggerType: 'manual', status: 'active', generatedCode: code },
  })
  const result = await executeAiFunction(fn.id, projectId, { type: 'manual', data }, { selfHeal: false })
  const runs = await prisma.aiFunctionLog.findMany({ where: { functionId: fn.id }, select: { success: true, error: true } })
  return { result, runs }
}

async function orders(ref: string): Promise<number> {
  const rows: Array<{ n: number }> = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "workspace_${projectId}"."orders" WHERE ref = $1`,
    ref,
  )
  return rows[0].n
}

const listen = (server: net.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()))

beforeAll(async () => {
  assertSafeTestDatabase()
  process.env[EGRESS_ENV] = 'true'
  userId = (await prisma.user.create({
    data: { email: `runs-once-${crypto.randomBytes(6).toString('hex')}@example.test`, name: 'Runs once' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'function-failure-runs-once', userId }, select: { id: true } })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "workspace_${projectId}"."orders" (id serial PRIMARY KEY, ref text NOT NULL)`)
  await prisma.projectIntegrationKey.create({
    data: { projectId, integrationId: 'resend', encryptedKey: encrypt(RESEND_KEY), maskedKey: 're_fn60…', verification: 'verified' },
  })

  // A port nothing listens on: taken, then let go.
  const spare = net.createServer()
  refusedUrl = `http://127.0.0.1:${await listen(spare)}/orders`
  await close(spare)
  // A host that takes each request and closes the connection without answering.
  dropper = net.createServer((socket) => {
    droppedConnections++
    socket.once('data', () => socket.end())
  })
  droppedUrl = `http://127.0.0.1:${await listen(dropper)}/orders`

  realFetch = global.fetch
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith('https://api.resend.com/')) return realFetch(input, init)
    receipts.push(JSON.parse(String(init?.body)).text)
    return { ok: true, status: 200, json: async () => ({ id: `em_${receipts.length}` }) } as unknown as Response
  }) as typeof fetch
}, 60_000)

beforeEach(() => {
  receipts = []
  droppedConnections = 0
  mockSandbox.failures = []
  mockSandbox.starts = 0
})

afterAll(async () => {
  global.fetch = realFetch
  if (ORIGINAL_EGRESS === undefined) delete process.env[EGRESS_ENV]
  else process.env[EGRESS_ENV] = ORIGINAL_EGRESS
  if (dropper) await close(dropper)
  if (projectId) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
    await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.projectIntegrationKey.deleteMany({ where: { projectId } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId } }).catch(() => {})
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

describe('a function whose code has started fails once', () => {
  it('a fulfilment host that refuses the connection: one order, one receipt, one failed run', async () => {
    const { result, runs } = await runFunction('order-refused', ORDER_THEN_FULFIL, { ref: 'refused', fulfilmentUrl: refusedUrl })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^connect ECONNREFUSED 127\.0\.0\.1:\d+$/)
    expect(await orders('refused')).toBe(1)
    expect(receipts).toEqual(['Order refused'])
    expect(runs).toEqual([{ success: false, error: result.error }])
    expect(mockSandbox.starts).toBe(1)
  }, 60_000)

  it('a fulfilment host that drops the connection: one connection, one order, one receipt', async () => {
    const { result, runs } = await runFunction('order-dropped', ORDER_THEN_FULFIL, { ref: 'dropped', fulfilmentUrl: droppedUrl })
    expect(result.success).toBe(false)
    expect(result.error).toBe('socket hang up')
    expect(droppedConnections).toBe(1)
    expect(await orders('dropped')).toBe(1)
    expect(receipts).toEqual(['Order dropped'])
    expect(runs).toHaveLength(1)
  }, 60_000)

  it("an error the code throws itself, worded like a socket error, fails once", async () => {
    const { result } = await runFunction(
      'order-thrown',
      `await ctx.db.insert('orders', { ref: 'thrown' })
       throw new Error('upstream said: connection reset by peer')`,
      {},
    )
    expect(result.error).toBe('upstream said: connection reset by peer')
    expect(await orders('thrown')).toBe(1)
    expect(mockSandbox.starts).toBe(1)
  }, 60_000)

  it('a call the code never awaited, refused after the code started, ends the run once', async () => {
    const { result } = await runFunction(
      'order-unawaited',
      `await ctx.db.insert('orders', { ref: 'unawaited' })
       ctx.http.post(event.data.fulfilmentUrl, {})
       await new Promise(() => {})`,
      { fulfilmentUrl: refusedUrl },
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/ECONNREFUSED/)
    expect(await orders('unawaited')).toBe(1)
    expect(mockSandbox.starts).toBe(1)
  }, 60_000)
})

describe('a sandbox that fails before the code starts is started again', () => {
  it('a runner whose script cannot load, or that cannot be made, is replaced, and the code runs once', async () => {
    mockSandbox.failures = ['missing-script', 'throw']
    const { result, runs } = await runFunction(
      'order-second-start',
      `await ctx.db.insert('orders', { ref: 'third-start' })
       return { ok: true }`,
      {},
    )
    expect({ success: result.success, error: result.error }).toEqual({ success: true, error: undefined })
    expect(result.returnValue).toEqual({ ok: true })
    expect(mockSandbox.starts).toBe(3)
    expect(await orders('third-start')).toBe(1)
    expect(runs).toEqual([{ success: true, error: null }])
  }, 60_000)

  it('three sandboxes that fail to start are one failed run, and the code never ran', async () => {
    mockSandbox.failures = ['missing-script', 'missing-script', 'missing-script']
    const { result, runs } = await runFunction(
      'order-no-sandbox',
      `await ctx.db.insert('orders', { ref: 'no-sandbox' })`,
      {},
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Cannot find module/)
    expect(mockSandbox.starts).toBe(3)
    expect(await orders('no-sandbox')).toBe(0)
    expect(runs).toHaveLength(1)
  }, 60_000)

  it("code that doesn't compile is refused once, not started again", async () => {
    const { result } = await runFunction('order-syntax', `await ctx.db.insert('orders', { ref: 'syntax' }`, {})
    expect(result.success).toBe(false)
    expect(mockSandbox.starts).toBe(1)
    expect(await orders('syntax')).toBe(0)
  }, 60_000)
})
