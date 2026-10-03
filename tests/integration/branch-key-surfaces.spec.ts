/**
 * A BRANCH-BOUND KEY NEVER REACHES PRODUCTION
 * ==========================================
 *
 * A key bound to a preview branch is routed to the branch by the data plane
 * (`/db/*`, `/api/v2`). Every other runtime surface resolves to the project's
 * main schema, and used to accept the key anyway: a signup "on the preview"
 * created a real end user and ran the production signup functions, and
 * `/fn/{name}` ran the production function.
 *
 * This drives the REAL `server/app.ts` over a real socket against a real
 * database, because the property is mount order: the refusal has to sit in
 * front of every router, including the auth routes that take no key and the
 * Next proxy. The Next side is the same check inside recordedV1, exercised
 * here on a wrapped handler that records whether it ran.
 */
import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { BRANCH_SURFACE_UNAVAILABLE, clearBranchKeyCache } from '@/lib/branches/key-scope'

let server: http.Server
let base: string
let ownerId: string
let projectId: string
let branchKey: string
let mergedBranchKey: string
let mainKey: string

async function makeKey(branchId: string | null): Promise<string> {
  const raw = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: branchId ? 'branch-key-surfaces branch' : 'branch-key-surfaces main',
      keyPrefix: raw.slice(0, 16),
      permissions: ['read', 'write'],
      capabilities: [],
      userId: ownerId,
      projectId,
      keyType: 'public',
      keyHash: hashApiKey(raw),
      branchId,
    },
  })
  return raw
}

async function call(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* SSE or empty */ }
  return { status: res.status, json, headers: res.headers }
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `branch-key-surfaces-${randomUUID()}@example.test` },
    select: { id: true },
  })
  ownerId = owner.id
  const project = await prisma.project.create({
    data: { name: `branch-key-surfaces-${randomUUID().slice(0, 8)}`, userId: ownerId },
    select: { id: true },
  })
  projectId = project.id

  // The refusal reads the key's branch row; no branch schema has to exist for
  // a request that is refused before any router runs.
  const active = await prisma.workspaceBranch.create({
    data: {
      projectId,
      name: 'preview',
      schemaName: `workspace_${projectId}_br_preview`,
      status: 'active',
      createdBy: ownerId,
    },
  })
  const merged = await prisma.workspaceBranch.create({
    data: {
      projectId,
      name: 'shipped',
      schemaName: `workspace_${projectId}_br_shipped`,
      status: 'merged',
      createdBy: ownerId,
      mergedAt: new Date(),
    },
  })
  branchKey = await makeKey(active.id)
  mergedBranchKey = await makeKey(merged.id)
  mainKey = await makeKey(null)
  clearBranchKeyCache()

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  // Project.user is onDelete: Cascade: the project, its branches and keys go too.
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}, 120_000)

interface Door {
  name: string
  method: string
  path: string
  body?: unknown
  carrier?: 'x-api-key' | 'bearer' | 'query'
  /**
   * Accepted, this door does not answer with a finished body here: realtime
   * opens a stream that never ends, and the Next-owned paths are proxied to a
   * Next server this suite does not run. Refusals are immediate either way, so
   * these are left out of the main-key control only.
   */
  openEnded?: boolean
}

/** Every door that resolves to main, one representative each. */
function mainOnlyDoors(id: string): Door[] {
  return [
    { name: 'end-user sign-up (no key needed)', method: 'POST', path: `/api/v1/${id}/auth/signup`, body: { email: 'preview@example.test', password: 'Correct-Horse-9' } },
    { name: 'end-user sign-in', method: 'POST', path: `/api/v1/${id}/auth/signin`, body: { email: 'preview@example.test', password: 'x' } },
    { name: 'function invocation', method: 'POST', path: `/api/v1/${id}/fn/send-welcome`, body: {} },
    { name: 'legacy database route', method: 'POST', path: `/api/v1/${id}/database/query`, body: { table: 'things' } },
    { name: 'realtime, key in the query string', method: 'GET', path: `/api/v1/${id}/realtime`, carrier: 'query', openEnded: true },
    { name: 'logs, key as a Bearer token', method: 'GET', path: `/api/v1/${id}/logs`, carrier: 'bearer' },
    { name: 'Next-owned storage (refused before the proxy)', method: 'GET', path: `/api/v1/${id}/storage/files`, openEnded: true },
    { name: 'vector search under the db prefix', method: 'POST', path: `/api/v1/${id}/db/things/vector-search`, body: {}, openEnded: true },
  ]
}

function withKey(door: Door, key: string): { path: string; headers: Record<string, string> } {
  if (door.carrier === 'query') return { path: `${door.path}?apiKey=${encodeURIComponent(key)}`, headers: {} }
  if (door.carrier === 'bearer') return { path: door.path, headers: { authorization: `Bearer ${key}` } }
  return { path: door.path, headers: { 'x-api-key': key } }
}

describe('a branch-bound key on a surface that is not branch-scoped', () => {
  it.each(mainOnlyDoors('__ID__'))('is refused on the $name door', async (door) => {
    const d = { ...door, path: door.path.replace('__ID__', projectId) }
    const { path, headers } = withKey(d, branchKey)
    const res = await call(d.method, path, { headers, body: d.body })
    expect(res.status).toBe(403)
    expect(res.json?.code).toBe(BRANCH_SURFACE_UNAVAILABLE)
    expect(res.json?.branch).toBe('preview')
  }, 60_000)

  it('is refused the same way when its branch has been merged', async () => {
    const res = await call('POST', `/api/v1/${projectId}/auth/signup`, {
      headers: { 'x-api-key': mergedBranchKey },
      body: { email: 'merged@example.test', password: 'Correct-Horse-9' },
    })
    expect(res.status).toBe(403)
    expect(res.json?.code).toBe(BRANCH_SURFACE_UNAVAILABLE)
  }, 60_000)
})

describe('a branch-bound key on the data plane', () => {
  it('is not refused by the surface check on /db', async () => {
    const res = await call('GET', `/api/v1/${projectId}/db/things`, { headers: { 'x-api-key': branchKey } })
    expect(res.json?.code).not.toBe(BRANCH_SURFACE_UNAVAILABLE)
    // The data plane itself answers, and says which environment did.
    expect(res.headers.get('x-backenly-environment')).toBe('branch:preview')
  }, 60_000)

  it('is not refused by the surface check on /api/v2, with the PostgREST apikey header', async () => {
    const res = await call('GET', `/api/v2/${projectId}/things`, { headers: { apikey: branchKey } })
    expect(res.json?.code).not.toBe(BRANCH_SURFACE_UNAVAILABLE)
  }, 60_000)

  it('is still refused as inactive on /db once its branch is merged, never served from main', async () => {
    const res = await call('GET', `/api/v1/${projectId}/db/things`, { headers: { 'x-api-key': mergedBranchKey } })
    expect(res.json?.code).toBe('BRANCH_INACTIVE')
    expect(res.headers.get('x-backenly-environment')).toBeNull()
  }, 60_000)
})

describe('a main key (the control)', () => {
  it.each(mainOnlyDoors('__ID__').filter(d => !d.openEnded))(
    'still reaches its router on the $name door',
    async (door) => {
      const d = { ...door, path: door.path.replace('__ID__', projectId) }
      const { path, headers } = withKey(d, mainKey)
      const res = await call(d.method, path, { headers, body: d.body })
      expect(res.json?.code).not.toBe(BRANCH_SURFACE_UNAVAILABLE)
    },
    60_000,
  )

  it('is told it reached main on the data plane', async () => {
    const res = await call('GET', `/api/v1/${projectId}/db/things`, { headers: { 'x-api-key': mainKey } })
    expect(res.headers.get('x-backenly-environment')).toBe('main')
  }, 60_000)

  it('lets a keyless request through, as before', async () => {
    const res = await call('POST', `/api/v1/${projectId}/auth/signin`, { body: { email: 'a@b.co', password: 'x' } })
    expect(res.json?.code).not.toBe(BRANCH_SURFACE_UNAVAILABLE)
  }, 60_000)
})

describe('the Next door (recordedV1)', () => {
  const ctx = () => ({ params: Promise.resolve({ projectId }) })

  function spyRoute() {
    const calls: string[] = []
    const handler = recordedV1(async (req: Request) => {
      calls.push(new URL(req.url).pathname)
      return new Response('{}', { status: 200 })
    })
    return { calls, handler }
  }

  it('refuses a branch key before the route runs', async () => {
    const { calls, handler } = spyRoute()
    const res = await handler(
      new Request(`http://x/api/v1/${projectId}/storage/upload`, { method: 'POST', headers: { 'x-api-key': branchKey } }),
      ctx(),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe(BRANCH_SURFACE_UNAVAILABLE)
    expect(calls).toEqual([])
  })

  it('lets a branch key through on the data plane, which the Next catch-all forwards to the runtime', async () => {
    const { calls, handler } = spyRoute()
    const res = await handler(new Request(`http://x/api/v1/${projectId}/db/things`, { headers: { 'x-api-key': branchKey } }), ctx())
    expect(res.status).toBe(200)
    expect(calls).toEqual([`/api/v1/${projectId}/db/things`])
  })

  it('runs the route for a main key and for no key', async () => {
    const { calls, handler } = spyRoute()
    await handler(new Request(`http://x/api/v1/${projectId}/auth/signup`, { method: 'POST', headers: { 'x-api-key': mainKey } }), ctx())
    await handler(new Request(`http://x/api/v1/${projectId}/auth/signup`, { method: 'POST' }), ctx())
    expect(calls).toHaveLength(2)
  })
})
