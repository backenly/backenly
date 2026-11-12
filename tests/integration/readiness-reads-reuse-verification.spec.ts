/**
 * The pages that show readiness reuse a recent behavioral verification of the
 * backend as it is now (production QA, 2026-11-09).
 *
 * GET /build-status (the Overview's badge, through the deep scan) and GET
 * /readiness (the Deploy page) ran the behavioral verifier on every request.
 * It signs a test user up twice, once over HTTP back into the same web task,
 * and writes and removes rows in the project's tables: 97% of /build-status's
 * time. The Overview asks for /build-status three times per load and the
 * Deploy page for /readiness twice, and QA measured them at 5.0–8.4 s and
 * 3.4–4.2 s.
 *
 * Real project, tables, end-user auth and HTTP stack (the runtime, served in
 * this process, where the verifier's HTTP calls go); the verifier is the real
 * one, counted.
 */
import '../helpers/next-request-polyfill'
import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'
import { NextRequest } from 'next/server'

// The Deploy page's route reads its session through next/headers, which
// only a real Next request carries: the cookie store is the request's, and
// the session behind it is a real row.
let cookieToken = ''
jest.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'auth-token' && cookieToken ? { value: cookieToken } : undefined) }),
  headers: async () => new Map<string, string>(),
}))

jest.mock('@/lib/ai/behavioral-verifier', () => {
  const actual = jest.requireActual('@/lib/ai/behavioral-verifier')
  return { ...actual, runBehavioralVerification: jest.fn(actual.runBehavioralVerification) }
})
import { runBehavioralVerification } from '@/lib/ai/behavioral-verifier'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { withChangeAttribution } from '@/lib/changes/ledger'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { generateToken } from '@/lib/auth/jwt'
import { forgetBehavioralVerifications, VERIFICATION_REUSE_MS } from '@/lib/deployment/verification-reuse'
import { GET as buildStatus } from '@/app/api/projects/[id]/build-status/route'
import { GET as readReadiness, POST as fixReadiness } from '@/app/api/projects/[id]/readiness/route'

const runs = runBehavioralVerification as jest.MockedFunction<typeof runBehavioralVerification>

let server: http.Server
let ownerId: string
let ownerEmail: string
let projectId: string
let schema: string
let token: string
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

const asPerson = (path: string, method = 'GET') =>
  new NextRequest(`https://backenly.test/api/projects/${projectId}/${path}`, {
    method,
    headers: { cookie: `auth-token=${token}` },
  })

async function overview(): Promise<any> {
  const res = await buildStatus(asPerson('build-status'), { params: Promise.resolve({ id: projectId }) })
  expect(res.status).toBe(200)
  return res.json()
}

async function deployPage(method: 'GET' | 'POST' = 'GET'): Promise<any> {
  const res = await (method === 'GET' ? readReadiness : fixReadiness)(asPerson('readiness', method), { params: Promise.resolve({}) } as any)
  expect(res.status).toBe(200)
  return (await res.json()).report
}

const behavioral = (report: any) => report.checks.find((c: any) => c.id === 'behavioral_verification')

async function addTable(tableName: string) {
  const ctx = { projectId, userId: ownerId, createdThisTurn: new Set<string>() }
  const made = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    dispatchTool('create_table', { tableName, columns: [{ name: 'label', type: 'text' }] }, ctx))
  if (!made.ok) throw new Error(`create_table ${tableName}: ${made.summary}`)
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js points the executor at an in-memory graph; governed changes
  // and the verifier need the real database.
  process.env.ENGINE_MODE = 'runtime'
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  process.env.NEXT_PUBLIC_APP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  ownerEmail = `readiness-reuse-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'Readiness Reuse' } })).id
  const project = await createProvisionedProject({ name: 'readiness-reuse', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await addTable('products')
  await ensureAuthUsersTable(projectId, { email: ownerEmail })
  token = generateToken({ userId: ownerId, email: ownerEmail })
  await prisma.session.create({ data: { userId: ownerId, token, expiresAt: new Date(Date.now() + 3600_000) } })
  cookieToken = token
}, 180_000)

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
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

beforeEach(() => {
  forgetBehavioralVerifications()
  runs.mockClear()
})

describe('the pages that show readiness', () => {
  it('verify once for an Overview that asks three times at once, and the Deploy page reuses it', async () => {
    const [a, b, c] = await Promise.all([overview(), overview(), overview()])
    expect(runs).toHaveBeenCalledTimes(1)
    expect([a, b, c].map((r) => r.summary.verdict)).toEqual([a.summary.verdict, a.summary.verdict, a.summary.verdict])

    const report = await deployPage()
    expect(runs).toHaveBeenCalledTimes(1)
    // A real verification ran and passed: the reuse is of a run that checked something.
    expect(behavioral(report)).toMatchObject({ status: 'pass' })
    expect(behavioral(report).details.some((d: string) => d.startsWith('✓'))).toBe(true)

    // Its test users are gone: the run cleaned up after itself, once.
    const left = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${schema}".users WHERE email LIKE '%.internal'`,
    )
    expect(left[0].n).toBe(0)
  }, 180_000)

  it('verify again once the backend changed', async () => {
    await overview()
    expect(runs).toHaveBeenCalledTimes(1)
    await addTable(`notes_${crypto.randomBytes(3).toString('hex')}`)
    await overview()
    expect(runs).toHaveBeenCalledTimes(2)
    await deployPage()
    expect(runs).toHaveBeenCalledTimes(2)
  }, 180_000)

  it('verify again after five minutes, with nothing changed', async () => {
    await deployPage()
    expect(runs).toHaveBeenCalledTimes(1)
    const later = Date.now() + VERIFICATION_REUSE_MS + 1
    const clock = jest.spyOn(Date, 'now').mockReturnValue(later)
    try {
      await deployPage()
    } finally {
      clock.mockRestore()
    }
    expect(runs).toHaveBeenCalledTimes(2)
  }, 180_000)

  it('do not keep a run that could not finish', async () => {
    runs.mockRejectedValueOnce(new Error('database unreachable'))
    const first = await deployPage()
    expect(behavioral(first)).toMatchObject({ status: 'fail', severity: 'warning' })
    await deployPage()
    expect(runs).toHaveBeenCalledTimes(2)
  }, 180_000)
})

describe('what verifies afresh', () => {
  it('fixing from the Deploy page runs its own verification', async () => {
    await deployPage()
    expect(runs).toHaveBeenCalledTimes(1)
    await deployPage('POST')
    expect(runs).toHaveBeenCalledTimes(2)
  }, 180_000)
})
