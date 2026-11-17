/**
 * Backenly's own check accounts do not stay in a project's users table.
 *
 * Production QA re-test, 2026-11-16, #20: an old project's users table held 3
 * rows its Auth page did not show (`__http_bv_…`, `__cv_…@backenly.internal`),
 * and the Database tab and the app's own queries counted them. A sign-up a
 * check gave up waiting for could complete after the check's own purge, a
 * process stopped mid-check never purged, run_test never purged a sign-up that
 * failed, and the build verifier "removed" its users through a route neither
 * runtime serves.
 *
 * Real project, users table and runtime (served in this process); the real
 * contract sweep, run_test create and build verifier.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { runContractVerification } from '@/lib/services/contract-verifier'
import { verifyCreate } from '@/lib/ai/brain/verify-create'
import app from '@/server/app'

let ownerId: string
let projectId: string
let schema: string
let runtime: http.Server
let runtimeUrl = ''
const originalProbeOrigin = process.env.CONTRACT_PROBE_ORIGIN
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

const users = () => `"${schema}"."users"`

async function addUser(email: string, minutesAgo: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${users()} (email, "createdAt") VALUES ($1, now() - make_interval(mins => $2::int))`,
    email,
    minutesAgo,
  )
}

/**
 * The users table's addresses, sorted here by code point. An ORDER BY would
 * follow the database's collation: with en_US.UTF-8, as on CI, the underscore
 * is ignored at first and `ana@…` comes before `__cv_…`, while a C cluster
 * puts `__cv_…` first.
 */
async function emails(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ email: string }>>(`SELECT email FROM ${users()}`)
  return rows.map((r) => r.email).sort()
}

beforeAll(async () => {
  runtime = http.createServer(app)
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
  runtimeUrl = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`

  const email = `check-accounts-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'Check accounts' } })).id
  projectId = (await prisma.project.create({
    data: { name: 'check-accounts', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
    select: { id: true },
  })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  // The end-user table as auth provisions it (lib/services/end-user-auth-table.ts).
  await prisma.$executeRawUnsafe(`CREATE TABLE ${users()} (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "email" TEXT UNIQUE NOT NULL, "password" TEXT,
    "name" TEXT, "role" TEXT NOT NULL DEFAULT 'user', "is_blocked" BOOLEAN NOT NULL DEFAULT FALSE,
    "last_login" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ DEFAULT NOW(), "updatedAt" TIMESTAMPTZ DEFAULT NOW())`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."notes" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text)`)
}, 120_000)

afterAll(async () => {
  // The database first: closing the server waits for its open connections.
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  runtime.closeAllConnections()
  await new Promise<void>((resolve) => runtime.close(() => resolve()))
  if (originalProbeOrigin === undefined) delete process.env.CONTRACT_PROBE_ORIGIN
  else process.env.CONTRACT_PROBE_ORIGIN = originalProbeOrigin
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
}, 60_000)

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM ${users()}`)
})

it('the contract sweep removes check accounts left behind, and only those', async () => {
  // Nothing answers here, so every probe fails fast; the sweep runs first.
  process.env.CONTRACT_PROBE_ORIGIN = 'http://127.0.0.1:9'
  await addUser('__cv_k2l9stale@backenly.internal', 20)
  await addUser('__http_bv_1794224302339@backenly.internal', 60 * 24 * 6)
  await addUser('behavioral_test_1794224302339@backenly-test.internal', 60)
  // A check still in progress keeps its account, and people are never touched.
  await addUser('__cv_k2l9fresh@backenly.internal', 1)
  await addUser('ana@corp.internal', 60)
  await addUser('real@example.test', 60)

  await runContractVerification(projectId)

  expect(await emails()).toEqual(['__cv_k2l9fresh@backenly.internal', 'ana@corp.internal', 'real@example.test'])
}, 60_000)

it("removes run_test's account when its sign-up completes after run_test gave up waiting", async () => {
  // Holds each sign-up for 1.5 s before sending it on to the runtime, on its
  // own, as a slow server would still process it: run_test gives up after 1 s,
  // and the account is created half a second later.
  let delivered: Promise<number> = Promise.resolve(0)
  const proxy = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const hold = req.url?.endsWith('/auth/signup') ? 1500 : 0
      delivered = new Promise<number>((done) => {
        setTimeout(() => {
          const upstream = http.request(`${runtimeUrl}${req.url}`, { method: req.method, headers: req.headers }, (answer) => {
            answer.resume()
            answer.on('end', () => done(answer.statusCode ?? 0))
            if (!res.destroyed) res.writeHead(answer.statusCode ?? 502, answer.headers).end()
          })
          upstream.on('error', () => done(0))
          upstream.end(body)
        }, hold)
      })
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  try {
    const result = await verifyCreate({
      projectId,
      schema,
      tableName: 'notes',
      appUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      anonKey: 'not-used-before-the-sign-up',
      timeoutMs: 1000,
      purgeAgainAfterMs: 3000,
    })
    expect(result).toMatchObject({ ok: false, exercised: false })
    // The sign-up run_test gave up on did create the account, after run_test's own purge.
    expect(await delivered).toBe(201)
    expect((await emails()).filter((e) => e.startsWith('__http_bv_'))).toHaveLength(1)
    // And the second purge removes it.
    await new Promise((r) => setTimeout(r, 2500))
    expect((await emails()).filter((e) => e.startsWith('__http_bv_'))).toEqual([])
  } finally {
    proxy.closeAllConnections()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  }
}, 60_000)

it("removes the build verifier's users when its scenarios finish", async () => {
  process.env.NEXT_PUBLIC_APP_URL = runtimeUrl
  jest.resetModules()
  const { runBehavioralScenarios } = await import('@/lib/ai/build-runtime/behavioral-verifier')
  const report = await runBehavioralScenarios(projectId, 'node-1')
  // It did sign users up: the auth scenario passed.
  expect(report.scenarios.find((s) => s.scenario === 'Auth: Signup + Signin')?.checks[0]).toMatchObject({ status: 'pass' })
  expect(await emails()).toEqual([])
}, 120_000)

it('the report lists check accounts, and --apply removes the ones no check still owns', async () => {
  const { reportCheckAccounts } = await import('@/lib/services/check-account-cleanup')
  await addUser('__cv_k2l9stale@backenly.internal', 20)
  await addUser('rls_userA_1794224302339@backenly-test.internal', 60)
  await addUser('__cv_k2l9fresh@backenly.internal', 1)
  await addUser('ana@corp.internal', 60)

  expect(await reportCheckAccounts(projectId, false)).toEqual({ found: 3, stale: 2, removed: 0, failure: null })
  expect(await emails()).toHaveLength(4)

  expect(await reportCheckAccounts(projectId, true)).toEqual({ found: 3, stale: 2, removed: 2, failure: null })
  expect(await emails()).toEqual(['__cv_k2l9fresh@backenly.internal', 'ana@corp.internal'])
}, 60_000)
