/**
 * A LOCKED PROJECT IS SEALED ON EVERY RUNTIME SURFACE
 * ===================================================
 *
 * Founder lockdown was checked by the Next-owned v1 middleware and the two
 * bootstrap routes, and by nothing else. The Express runtime serves `/db/*`,
 * `/api/v2/*`, end-user auth, functions and realtime, and it never read
 * `lockedDownAt`, so a project sealed because it was compromised kept serving
 * all of them to any valid key.
 *
 * This drives the REAL `server/app.ts` over a real socket against a real
 * database, because the property under test is mount order: the gate has to
 * sit in front of every router, including the Next proxy and the auth routes
 * that take no API key. Calling the gate function directly would prove the
 * function works and nothing about whether any request reaches it.
 *
 * Requests carry no credentials on purpose. Without the gate every one of them
 * would be answered by a router (401, 400, a proxy error). With it, a locked
 * project is refused before any router runs, and the open project in the
 * control group still reaches its routers exactly as before.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { LOCKED_MESSAGE } from '@/server/lib/serving-gate'
import { PAUSED_CODE, PAUSED_MESSAGE } from '@/lib/projects/serving-state'

let server: http.Server
let base: string
let ownerId: string

/**
 * Owned, as every Cloud project is. An owner-less project also makes the
 * bootstrap route's anon-key provisioning throw (ApiKey requires a user),
 * which is noise this suite is not about.
 */
async function makeProject(state: 'open' | 'locked' | 'paused'): Promise<string> {
  const project = await prisma.project.create({
    data: {
      name: `serving-gate-${state}-${randomUUID().slice(0, 8)}`,
      userId: ownerId,
      lockedDownAt: state === 'locked' ? new Date() : null,
      lockedDownReason: state === 'locked' ? 'serving-gate test' : null,
      pausedAt: state === 'paused' ? PAUSED_AT : null,
      pauseReason: state === 'paused' ? 'inactivity' : null,
    },
    select: { id: true },
  })
  return project.id
}

const PAUSED_AT = new Date('2026-09-10T08:00:00.000Z')

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    // OAuth start answers with a redirect to the provider. Following it would
    // make this suite depend on reaching Google.
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* SSE or empty */ }
  return { status: res.status, json }
}

interface Door {
  name: string
  method: string
  path: string
  body?: unknown
}

/**
 * Every door a runtime request can come in through, one representative each.
 *
 * Object rows, not arrays. With array rows `it.each` passes one argument per
 * element, and a row shorter than the test function's parameter list makes
 * jest hand the missing slot a `done` callback and wait for it. That is how
 * every body-less GET here first "hung" for 60s while the server had already
 * answered it in milliseconds.
 */
function doors(id: string): Door[] {
  return [
    { name: 'dynamic table CRUD', method: 'GET', path: `/api/v1/${id}/db/things` },
    { name: 'database route', method: 'POST', path: `/api/v1/${id}/database/query`, body: { table: 'things' } },
    { name: 'end-user sign-in (no API key)', method: 'POST', path: `/api/v1/${id}/auth/signin`, body: { email: 'a@b.co', password: 'x' } },
    { name: 'end-user OAuth start (no API key)', method: 'GET', path: `/api/v1/${id}/auth/google` },
    { name: 'realtime', method: 'GET', path: `/api/v1/${id}/realtime` },
    { name: 'bootstrap', method: 'GET', path: `/api/v1/${id}/bootstrap` },
    { name: 'PostgREST grammar', method: 'GET', path: `/api/v2/${id}/things` },
    { name: 'Next-owned surface (proxied)', method: 'GET', path: `/api/v1/${id}/storage/buckets` },
  ]
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `serving-gate-${randomUUID()}@example.test` },
    select: { id: true },
  })
  ownerId = owner.id

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  // Project.user is onDelete: Cascade, so this removes the fixtures' projects too.
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  // fetch keeps sockets alive, and close() waits for every one of them.
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}, 120_000)

describe('a locked project', () => {
  let id: string
  beforeAll(async () => { id = await makeProject('locked') }, 60_000)

  it.each(doors('__ID__'))('is refused on the $name door', async ({ method, path, body }) => {
    const res = await call(method, path.replace('__ID__', id), body)
    expect(res.status).toBe(503)
    expect(res.json?.error?.message).toBe(LOCKED_MESSAGE)
  }, 60_000)
})

describe('a paused project', () => {
  let id: string
  beforeAll(async () => { id = await makeProject('paused') }, 60_000)

  it.each(doors('__ID__'))('is refused on the $name door, with where to resume it', async ({ method, path, body }) => {
    const res = await call(method, path.replace('__ID__', id), body)
    expect(res.status).toBe(503)
    expect(res.json?.error).toMatchObject({
      code: PAUSED_CODE,
      message: PAUSED_MESSAGE,
      details: {
        pausedAt: PAUSED_AT.toISOString(),
        reason: 'inactivity',
        resumePath: `/app/projects/${id}`,
      },
    })
  }, 60_000)

  it('does not tell the client to retry, because nothing changes until the owner resumes', async () => {
    const res = await fetch(`${base}/api/v1/${id}/db/things`, { redirect: 'manual' })
    await res.text()
    expect(res.headers.get('retry-after')).toBeNull()
  }, 60_000)
})

describe('an open project (the control)', () => {
  let id: string
  beforeAll(async () => { id = await makeProject('open') }, 60_000)

  // The proxied Next surface is left out: with no Next server listening its
  // answer depends on whatever happens to own port 3000 on the machine.
  it.each(doors('__ID__').filter(d => !d.name.startsWith('Next-owned')))(
    'still reaches its router on the $name door',
    async ({ method, path, body }) => {
      const res = await call(method, path.replace('__ID__', id), body)
      expect(res.json?.error?.message).not.toBe(LOCKED_MESSAGE)
      expect(res.json?.error?.code).not.toBe('PROJECT_STATE_UNAVAILABLE')
    },
    60_000,
  )
})

/**
 * The dynamic CRUD handler serves the project the KEY belongs to, and still
 * accepts the legacy `/api/v1/{tableName}` form with no project id in the path.
 * The URL-keyed gate cannot judge a path with no project in it, so the project
 * actually being served has to be judged where it becomes known: after the key
 * is resolved.
 */
describe('the legacy path that names no project, only a table', () => {
  async function keyFor(projectId: string): Promise<string> {
    const raw = `bk_test_${randomBytes(16).toString('hex')}`
    await prisma.apiKey.create({
      data: {
        name: 'serving-gate legacy path',
        keyPrefix: raw.slice(0, 12),
        permissions: ['read', 'write'],
        capabilities: [],
        userId: ownerId,
        projectId,
        keyType: 'public',
        keyHash: hashApiKey(raw),
      },
    })
    return raw
  }

  async function legacy(key: string) {
    const res = await fetch(`${base}/api/v1/things`, {
      headers: { 'x-api-key': key },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json }
  }

  it("refuses a paused project's key", async () => {
    const res = await legacy(await keyFor(await makeProject('paused')))
    expect(res.status).toBe(503)
    expect(res.json?.error?.code).toBe(PAUSED_CODE)
  }, 60_000)

  it("refuses a locked project's key", async () => {
    const res = await legacy(await keyFor(await makeProject('locked')))
    expect(res.status).toBe(503)
    expect(res.json?.error?.message).toBe(LOCKED_MESSAGE)
  }, 60_000)

  it("still serves an open project's key (the control)", async () => {
    const res = await legacy(await keyFor(await makeProject('open')))
    expect(res.status).not.toBe(503)
  }, 60_000)
})

describe('paths the gate must leave alone', () => {
  it('passes a project id that does not exist through to the routes', async () => {
    const res = await call('GET', `/api/v1/${randomUUID()}/db/things`)
    expect(res.status).not.toBe(503)
  }, 60_000)

  it('ignores a first segment that is not a project id', async () => {
    const res = await call('GET', '/api/v1/not-a-project/db/things')
    expect(res.status).not.toBe(503)
  }, 60_000)

  it('does not stand in front of the health check', async () => {
    const res = await call('GET', '/health')
    expect(res.status).toBe(200)
  }, 60_000)
})
