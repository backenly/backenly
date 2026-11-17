/**
 * A KEY'S RESPONSES SAY WHAT THE KEY IS
 * =====================================
 * Creating an admin key answered `"keyType": "public"` beside
 * `"kind": "service"` (production QA re-test 2026-11-16, report #106).
 * `keyType` is a storage value meaning "not a dashboard key": every project key
 * is 'public', service and admin keys included, so the field read "public" for
 * every key the API keys routes return and told a reader nothing. `kind` is the
 * answer (lib/auth/key-prefix.ts), and the reading routes did not carry it.
 *
 *   • every response that returns a key carries `kind` and no `keyType`:
 *     create, list, read, change and rotate;
 *   • requests may still send `keyType`, as the console and older clients do;
 *   • the list says the window that decides each key's requests, so the console
 *     no longer works out "per address" from `keyType` itself.
 */

import { randomBytes, randomUUID } from 'crypto'

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

import '@/tests/helpers/real-web-standard'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { hashApiKey } from '@/server/lib/end-user-identity'

let ownerId = ''
let token = ''
let projectId = ''
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

function request(method: string, path: string, body?: unknown, query: Record<string, string> = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-project-id': projectId }
  const searchParams = new URLSearchParams(query)
  return {
    method,
    url: `http://localhost:3000${path}${query && Object.keys(query).length ? `?${searchParams}` : ''}`,
    nextUrl: { pathname: path, searchParams, origin: 'http://localhost:3000' },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined },
    json: async () => body,
  } as any
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function create(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/api-keys/route')
  const res: any = await POST(request('POST', '/api/api-keys', { projectId, ...body }, { projectId }))
  return { status: res.status as number, body: await res.json() }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  const email = `key-kind-${randomUUID()}@example.test`
  ownerId = (await prisma.user.create({ data: { email, name: 'Key kinds' }, select: { id: true } })).id
  token = (await createSession(ownerId, email, 'user')).token
  projectId = (await prisma.project.create({ data: { name: `key-kind-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
})

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
})

describe('creating a key', () => {
  it('answers with what the key is, not "public"', async () => {
    const res = await create({ name: 'worker', role: 'admin', serviceRole: true })
    expect(res.status).toBe(201)
    expect(res.body.apiKey.kind).toBe('service')
    expect(res.body.apiKey).not.toHaveProperty('keyType')
  })

  it('still accepts keyType in the request, as the console sends it', async () => {
    const res = await create({ name: 'browser', keyType: 'public', role: 'client', serviceRole: false })
    expect(res.status).toBe(201)
    expect(res.body.apiKey.kind).toBe('publishable')
    expect(res.body.apiKey).not.toHaveProperty('keyType')
  })
})

describe('reading keys', () => {
  let browserId = ''
  let serviceId = ''
  let legacyId = ''

  beforeAll(async () => {
    browserId = (await create({ name: 'list browser', role: 'client', serviceRole: false })).body.apiKey.id
    serviceId = (await create({ name: 'list service', role: 'admin', serviceRole: true })).body.apiKey.id
    // An older project's Default Key: the admin role without the service role.
    const raw = `proj_live_${randomBytes(32).toString('hex')}`
    legacyId = (
      await prisma.apiKey.create({
        data: {
          name: 'Old Default Key',
          keyHash: hashApiKey(raw),
          keyPrefix: 'proj_live_',
          keyType: 'public',
          role: 'admin',
          permissions: [],
          capabilities: [],
          serviceRole: false,
          projectId,
          userId: ownerId,
        },
        select: { id: true },
      })
    ).id
  })

  it('the list names each key by its kind and says the window that decides its requests', async () => {
    const { GET } = await import('@/app/api/api-keys/route')
    const res: any = await GET(request('GET', '/api/api-keys', undefined, { projectId }))
    expect(res.status).toBe(200)
    const keys: any[] = (await res.json()).apiKeys
    const byId = new Map(keys.map((k) => [k.id, k]))
    for (const k of keys) expect(k).not.toHaveProperty('keyType')

    // A browser key is counted per address, at the burst brake until its owner sets a rate.
    expect(byId.get(browserId)).toMatchObject({ kind: 'publishable', clientWindow: { limit: 300, windowSeconds: 10, perAddress: true } })
    // A service key one server holds is counted against itself.
    expect(byId.get(serviceId)).toMatchObject({ kind: 'service', clientWindow: { limit: 1000, windowSeconds: 3600, perAddress: false } })
    // The runtime counts an admin-role Default Key per address too (lib/security/shared-key.ts).
    expect(byId.get(legacyId)).toMatchObject({ kind: 'server', clientWindow: { perAddress: true } })
  })

  it('one key, read on its own, says its kind', async () => {
    const { GET } = await import('@/app/api/api-keys/[id]/route')
    const res: any = await GET(request('GET', `/api/api-keys/${serviceId}`), params(serviceId))
    expect(res.status).toBe(200)
    const { apiKey } = await res.json()
    expect(apiKey).toMatchObject({ id: serviceId, kind: 'service', clientWindow: { perAddress: false } })
    expect(apiKey).not.toHaveProperty('keyType')
  })

  it('a changed key says its kind', async () => {
    const { PUT } = await import('@/app/api/api-keys/[id]/route')
    const res: any = await PUT(request('PUT', `/api/api-keys/${browserId}`, { name: 'list browser, renamed' }), params(browserId))
    expect(res.status).toBe(200)
    const { apiKey } = await res.json()
    expect(apiKey).toMatchObject({ id: browserId, name: 'list browser, renamed', kind: 'publishable', clientWindow: { perAddress: true } })
    expect(apiKey).not.toHaveProperty('keyType')
  })

  it('a rotated key says its kind', async () => {
    const { POST } = await import('@/app/api/api-keys/[id]/rotate/route')
    const res: any = await POST(request('POST', `/api/api-keys/${serviceId}/rotate`), params(serviceId))
    expect(res.status).toBe(200)
    const { apiKey } = await res.json()
    expect(apiKey).toMatchObject({ id: serviceId, kind: 'service' })
    expect(apiKey.key).toMatch(/^svc_live_[a-f0-9]{64}$/)
    expect(apiKey).not.toHaveProperty('keyType')
  })
})
