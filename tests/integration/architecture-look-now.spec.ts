/**
 * A PERSON CAN ASK BACKENLY TO LOOK FOR ARCHITECTURE CHANGES, ONCE IN A WHILE
 * ==========================================================================
 *
 * Production QA (2026-11-09): the look for architecture changes ran once a day
 * and the console had no way to ask for one; the tester called the route's
 * `assess` by hand. The Autonomy page now offers "Look now"
 * (components/autonomy/ArchitectureLookNow.tsx). A look rehearses every
 * proposal, some 700 statements each, so the route answers one per project
 * every 10 minutes and says when the next may start. Real session, project and
 * engine.
 */
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: 7 }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import '../helpers/real-web-standard'
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { createProvisionedProject } from '@/lib/projects/provision'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { GET, POST } from '@/app/api/projects/[id]/architecture/route'

let ownerId: string
let token: string
let projectId: string
let schema: string
const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  const email = `look-now-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'owner' } })).id
  token = (await createSession(ownerId, email)).token
  const project = await createProvisionedProject({ name: 'architecture-look-now', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  resetSingleTenantCache()
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

function req(method: 'GET' | 'POST', body?: unknown): any {
  const path = `/api/projects/${projectId}/architecture`
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  return {
    method,
    url: `http://localhost:3000${path}`,
    nextUrl: { pathname: path, searchParams: new URLSearchParams() },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => body ?? {},
  }
}
const params = { params: Promise.resolve({ id: projectId }) }

it('looks when asked, then answers the next ask within 10 minutes with when it may start', async () => {
  const first: any = await POST(req('POST', { action: 'assess' }), params)
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({ ok: true })

  const second: any = await POST(req('POST', { action: 'assess' }), params)
  expect(second.status).toBe(429)
  expect(second.headers.get('retry-after')).toMatch(/^\d+$/)
  expect(await second.json()).toEqual({
    error: 'Backenly looked for changes in the last 10 minutes. Ask again in 10 minutes.',
    code: 'ASSESSED_RECENTLY',
  })
}, 120_000)

it('says when it last looked', async () => {
  const res: any = await GET(req('GET'), params)
  expect(res.status).toBe(200)
  const summary = await res.json()
  expect(new Date(summary.analyzedAt).getTime()).toBeGreaterThan(Date.now() - 5 * 60_000)
}, 120_000)
