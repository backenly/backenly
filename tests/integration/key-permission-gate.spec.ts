/**
 * A KEY'S PERMISSION SET GOVERNS EVERY DATA DOOR
 * ==============================================
 * `set_key_permissions` and the key editor have always written
 * `ApiKey.permissions`, and the tool answered "✅ permissions updated" — but
 * the data plane never read the field: only the legacy Express /database and
 * /logs routers checked it, while /api/v1/{id}/db/... and /api/v2/... served
 * reads AND writes to any valid key. Narrowing a leaked key to ['read'] over
 * MCP changed nothing that mattered.
 *
 * This drives the REAL server/app.ts over a real socket against a real
 * database, the same harness as key-placement-surfaces, because the property
 * is door coverage: the gate has to sit on BOTH data doors, after
 * authentication, before anything downstream runs.
 *
 *   ['read']            GET passes the gate · POST/PATCH/DELETE 403 on BOTH doors
 *   ['read','write']    POST passes the gate
 *   serviceRole         bypasses, by definition (matches checkPermission)
 *   SET_KEY_PERMISSIONS narrowing a key over the real executor takes effect on
 *                       the very next request — the end-to-end truth the tool
 *                       has always claimed
 */
import '@/tests/helpers/real-web-standard'
import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'
import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { executeAction } from '@/lib/ai/minimal-executor'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let server: http.Server
let base = ''
let ownerId = ''
let projectId = ''

async function makeKey(permissions: string[], serviceRole = false): Promise<{ raw: string; id: string }> {
  const raw = `proj_live_${randomBytes(24).toString('hex')}`
  const row = await prisma.apiKey.create({
    data: {
      name: `gate-${permissions.join('-') || 'none'}${serviceRole ? '-svc' : ''}`,
      keyPrefix: raw.slice(0, 16),
      keyHash: hashApiKey(raw),
      permissions,
      capabilities: [],
      userId: ownerId,
      projectId,
      keyType: 'public',
      scope: 'runtime',
      serviceRole,
      rateLimit: 1000,
    },
    select: { id: true },
  })
  return { raw, id: row.id }
}

async function call(method: string, path: string, key: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'x-api-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* empty */ }
  return { status: res.status, json }
}

const GATE = 'INSUFFICIENT_KEY_PERMISSIONS'
const codeOf = (r: { json: any }) => r.json?.code ?? r.json?.error?.code

beforeAll(async () => {
  assertSafeTestDatabase()
  const u = await prisma.user.create({
    data: { email: `gate-${randomUUID()}@test.invalid`, name: 'Permission Gate Test' },
    select: { id: true },
  })
  ownerId = u.id
  const p = await prisma.project.create({
    data: { name: `gate-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  projectId = p.id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60000)

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } })
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('a read-only key', () => {
  it('passes the gate on GET and is refused on writes, on the legacy door', async () => {
    const k = await makeKey(['read'])

    const get = await call('GET', `/api/v1/${projectId}/db/notes`, k.raw)
    const post = await call('POST', `/api/v1/${projectId}/db/notes`, k.raw, { title: 'x' })

    // GET may fail downstream (no such table) — what it must not be is the gate.
    expect(codeOf(get)).not.toBe(GATE)
    expect(post.status).toBe(403)
    expect(codeOf(post)).toBe(GATE)
    expect(post.json?.required).toBe('write')
  })

  it('is refused on writes on the v2 door too', async () => {
    const k = await makeKey(['read'])

    const get = await call('GET', `/api/v2/${projectId}/notes`, k.raw)
    const post = await call('POST', `/api/v2/${projectId}/notes`, k.raw, { title: 'x' })
    const del = await call('DELETE', `/api/v2/${projectId}/notes?id=eq.1`, k.raw)

    expect(codeOf(get)).not.toBe(GATE)
    expect(post.status).toBe(403)
    expect(codeOf(post)).toBe(GATE)
    expect(del.status).toBe(403)
    expect(codeOf(del)).toBe(GATE)
  })
})

describe('authority that must keep working', () => {
  it('a read+write key passes the gate on writes', async () => {
    const k = await makeKey(['read', 'write'])

    const post = await call('POST', `/api/v2/${projectId}/notes`, k.raw, { title: 'x' })

    expect(codeOf(post)).not.toBe(GATE)
  })

  it('a service-role key bypasses the gate by definition', async () => {
    const k = await makeKey([], true)

    const post = await call('POST', `/api/v1/${projectId}/db/notes`, k.raw, { title: 'x' })

    expect(codeOf(post)).not.toBe(GATE)
  })
})

describe('set_key_permissions over the real executor', () => {
  it('narrowing a key takes effect on the very next request', async () => {
    const k = await makeKey(['read', 'write'])
    const before = await call('POST', `/api/v2/${projectId}/notes`, k.raw, { title: 'x' })
    expect(codeOf(before)).not.toBe(GATE)

    const result = await executeAction(
      { action: 'SET_KEY_PERMISSIONS', params: { keyId: k.id, permissions: ['read'], confirmed: true } } as any,
      projectId
    )
    expect(result.success).toBe(true)

    const after = await call('POST', `/api/v2/${projectId}/notes`, k.raw, { title: 'x' })
    expect(after.status).toBe(403)
    expect(codeOf(after)).toBe(GATE)

    const read = await call('GET', `/api/v2/${projectId}/notes`, k.raw)
    expect(codeOf(read)).not.toBe(GATE)
  })
})
