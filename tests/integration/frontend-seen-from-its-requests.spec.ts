/**
 * A FRONTEND IS SEEN FROM ITS REQUESTS, LOCALHOST INCLUDED
 * ========================================================
 *
 * Production QA (2026-11-09): a store at localhost:5173 called the API with its
 * key all session, and the sidebar said "Frontend: Not connected", Deploy said
 * "No requests yet". Connection Health counted only the SDK's bootstrap ping,
 * and threw localhost away as "the platform".
 *
 * The request log now keeps each request's browser origin, and Connection
 * Health counts a frontend's successful production requests from it. Real
 * database, real session, the real recorder and route.
 */

import { randomUUID } from 'crypto'

jest.mock('@cloud/project-access', () => {
  try {
    return jest.requireActual('@/lib/cloud/project-access')
  } catch {
    return {
      async organizationRoleForProject() {
        return null
      },
      async organizationProjectClauses() {
        return []
      },
    }
  }
})

import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { recordRuntimeRequest, flushRecordedRequests } from '@/lib/traffic/request-recorder'
import { GET } from '@/app/api/projects/[id]/connection-health/route'

const ORIGINAL = { edition: process.env.BACKENLY_EDITION, appUrl: process.env.NEXT_PUBLIC_APP_URL }
let owner = { id: '', token: '' }
const projectIds: string[] = []

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.NEXT_PUBLIC_APP_URL = 'https://backenly.test'
  resetSingleTenantCache()
  const email = `frontend-seen-${randomUUID()}@test.invalid`
  const id = (await prisma.user.create({ data: { email, name: 'Frontend Seen' }, select: { id: true } })).id
  owner = { id, token: (await createSession(id, email)).token }
}, 60_000)

afterAll(async () => {
  await flushRecordedRequests()
  if (ORIGINAL.edition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL.edition
  if (ORIGINAL.appUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL.appUrl
  resetSingleTenantCache()
  await prisma.securityEvent.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: owner.id } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: owner.id } }).catch(() => {})
}, 60_000)

async function newProject() {
  const id = (await prisma.project.create({ data: { name: `frontend-seen-${randomUUID().slice(0, 8)}`, userId: owner.id }, select: { id: true } })).id
  projectIds.push(id)
  return id
}

function served(projectId: string, status: number, headers: Record<string, string>, branchId: string | null = null) {
  recordRuntimeRequest({
    projectId, method: 'GET', pathname: `/api/v1/${projectId}/db/products`,
    statusCode: status, durationMs: 4, headers: new Headers(headers), branchId,
  })
}

async function health(projectId: string) {
  const path = `/api/projects/${projectId}/connection-health`
  const headers: Record<string, string> = { authorization: `Bearer ${owner.token}`, 'x-project-id': projectId }
  const res: any = await GET({
    method: 'GET',
    url: `http://localhost:3000${path}`,
    nextUrl: { pathname: path, searchParams: new URLSearchParams() },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
  } as any)
  expect(res.status).toBe(200)
  return res.json()
}

it('reads an app calling from localhost with its key as connected, with its real request count', async () => {
  const projectId = await newProject()
  const app = { origin: 'http://localhost:5173', 'x-api-key': 'proj_live_app' }
  for (let i = 0; i < 5; i++) served(projectId, 200, app)
  served(projectId, 401, { ...app, 'x-api-key': 'proj_live_revoked' })   // a failure, not a success
  served(projectId, 200, app, 'branch-1')                                // a preview branch, not production
  served(projectId, 200, { 'x-api-key': 'proj_live_server' })            // a server: not a frontend
  served(projectId, 200, { referer: `https://backenly.test/app/projects/${projectId}/realtime` }) // the console
  await flushRecordedRequests()

  const h = await health(projectId)
  expect(h.successes).toEqual([expect.objectContaining({ origin: 'localhost:5173', count: 5 })])
  expect(h.totals).toMatchObject({ requests24h: 5, distinctOriginsConnected: 1 })
})

it('counts a bootstrap ping once, and still shows an origin only a ping has seen', async () => {
  const projectId = await newProject()
  const shop = { origin: 'https://shop.example', 'x-api-key': 'proj_live_app' }
  for (let i = 0; i < 3; i++) served(projectId, 200, shop)
  await flushRecordedRequests()
  for (const origin of ['https://shop.example', 'https://old.example']) {
    await prisma.securityEvent.create({
      data: { kind: 'bootstrap', severity: 'info', projectId, summary: `SDK bootstrap from ${origin}`, detail: { origin } },
    })
  }

  const h = await health(projectId)
  const byOrigin = Object.fromEntries(h.successes.map((s: { origin: string; count: number }) => [s.origin, s.count]))
  expect(byOrigin).toEqual({ 'shop.example': 3, 'old.example': 1 })
  expect(h.totals.requests24h).toBe(4)
})
