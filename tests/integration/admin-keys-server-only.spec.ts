/**
 * THE DEFAULT KEY IS PUBLISHABLE, AND AN ADMIN KEY STAYS ON A SERVER
 * =================================================================
 * Every project's Default Key was minted with the admin role and the
 * browser-safe `proj_live_` prefix. The admin role skips every permission check
 * and makes storage treat the key as an operator, and the browser guard refused
 * only service-role keys, so a frontend that shipped it let any visitor list,
 * download and delete every stored file and spend the project's AI credits.
 *
 *   • a new project's Default Key is publishable: the client role, read and
 *     write, no AI generation;
 *   • a new key may not carry the admin role without being a service key;
 *   • an admin-role key already issued that way is served to browsers, and
 *     the use recorded, until ADMIN_KEYS_SERVER_ONLY_FROM, then refused at
 *     the runtime's door and in each route's own authentication, as a
 *     service-role key is; from a server it is always served.
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
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { createDefaultApiKey } from '@/lib/projects/default-api-key'
import { getProjectIdFromAuth } from '@/server/routes/dynamic'
import { v1AuthMiddleware } from '@/server/lib/auth'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import { clearKeyPlacementCache, refuseMisplacedKey } from '@/lib/security/key-placement'
import { ADMIN_KEY_BROWSER_USE, ADMIN_KEY_IN_BROWSER, clearAdminKeyBrowserRecords } from '@/lib/security/admin-key-placement'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const BROWSER: Record<string, string> = {
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  origin: 'https://shop.example.test',
  'user-agent': CHROME_UA,
}

let ownerId = ''
let token = ''
let projectId = ''
let legacyKey = ''
let legacyKeyId = ''
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

const headersOf = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null })
const nextReq = (key: string, extra: Record<string, string> = {}) =>
  new NextRequest(`https://backenly.test/api/v1/${projectId}/storage/files`, { headers: { ...extra, 'x-api-key': key } })
const expressReq = (key: string, extra: Record<string, string> = {}) =>
  ({
    params: { projectId },
    query: {},
    method: 'GET',
    originalUrl: `/api/v1/${projectId}/db/things`,
    url: `/api/v1/${projectId}/db/things`,
    headers: { ...extra, 'x-api-key': key },
  }) as any
function fakeRes() {
  const res: any = { statusCode: 0, body: null, headers: {} as Record<string, string> }
  res.status = (code: number) => {
    res.statusCode = code
    return res
  }
  res.json = (body: unknown) => {
    res.body = body
    return res
  }
  res.setHeader = (name: string, value: string) => {
    res.headers[name] = value
  }
  return res
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  const email = `admin-keys-${randomUUID()}@example.test`
  ownerId = (await prisma.user.create({ data: { email, name: 'Admin keys' }, select: { id: true } })).id
  token = (await createSession(ownerId, email, 'user')).token
  projectId = (await prisma.project.create({ data: { name: `admin-keys-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id

  // A Default Key as every project got before the fix.
  legacyKey = `proj_live_${randomBytes(32).toString('hex')}`
  legacyKeyId = (
    await prisma.apiKey.create({
      data: {
        name: 'Shop Default Key',
        keyHash: hashApiKey(legacyKey),
        keyPrefix: 'proj_live_',
        keyType: 'public',
        role: 'admin',
        permissions: [],
        capabilities: ['database', 'auth', 'storage', 'functions', 'ai'],
        serviceRole: false,
        projectId,
        userId: ownerId,
        rateLimit: 1000,
        rateLimitWindow: 3600,
      },
      select: { id: true },
    })
  ).id
})

afterEach(() => {
  delete process.env.ADMIN_KEYS_SERVER_ONLY_FROM
  clearKeyPlacementCache()
  clearAdminKeyBrowserRecords()
})

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
})

describe("a new project's Default Key", () => {
  it('is publishable: the client role, read and write, no AI generation', async () => {
    const plaintext = await createDefaultApiKey(projectId, 'Shop', ownerId)
    expect(plaintext).toMatch(/^proj_live_[a-f0-9]{64}$/)
    const row = await prisma.apiKey.findFirst({
      where: { keyHash: hashApiKey(plaintext!) },
      select: { role: true, permissions: true, capabilities: true, serviceRole: true },
    })
    expect(row).toEqual({ role: 'client', permissions: ['read', 'write'], capabilities: ['database', 'auth', 'storage', 'functions'], serviceRole: false })
  })
})

describe('a new key', () => {
  const create = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/api-keys/route')
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-project-id': projectId }
    return (await POST({
      method: 'POST',
      url: `http://localhost:3000/api/api-keys?projectId=${projectId}`,
      nextUrl: { pathname: '/api/api-keys', searchParams: new URLSearchParams({ projectId }), origin: 'http://localhost:3000' },
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      cookies: { get: () => undefined },
      json: async () => body,
    } as any)) as any
  }

  it('may not carry the admin role without being a service key', async () => {
    const res = await create({ name: 'hybrid', role: 'admin', serviceRole: false, projectId })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('ADMIN_KEY_NEEDS_SERVICE_ROLE')
  })

  it('says what it is, not just "public"', async () => {
    const res = await create({ name: 'server', role: 'admin', serviceRole: true, projectId })
    expect(res.status).toBe(201)
    expect((await res.json()).apiKey).toMatchObject({ keyType: 'public', kind: 'service' })
  })
})

describe('an admin-role key already issued with the browser-safe prefix', () => {
  it('is served to a browser until a date is set, and the use is recorded', async () => {
    expect(await refuseMisplacedKey(`/api/v1/${projectId}/storage/files`, headersOf(BROWSER))).toBeNull()
    // The door read the key from the request; this is the same request.
    expect(await refuseMisplacedKey(`/api/v1/${projectId}/storage/files`, { get: (n: string) => (n === 'x-api-key' ? legacyKey : BROWSER[n.toLowerCase()] ?? null) })).toBeNull()
    const { response } = await v1ApiMiddleware(nextReq(legacyKey, BROWSER), { projectId })
    expect(response ?? null).toBeNull()

    const seen = await prisma.auditLog.findMany({ where: { projectId, action: ADMIN_KEY_BROWSER_USE }, select: { details: true } })
    expect(seen.length).toBe(1)
    expect(JSON.parse(String(seen[0].details))).toMatchObject({ apiKeyId: legacyKeyId, origin: 'https://shop.example.test' })
  })

  it('is refused from a browser from that date on, at the door and in every route', async () => {
    process.env.ADMIN_KEYS_SERVER_ONLY_FROM = new Date(Date.now() - 60_000).toISOString()
    const door = await refuseMisplacedKey(`/api/v1/${projectId}/storage/files`, {
      get: (n: string) => (n === 'x-api-key' ? legacyKey : BROWSER[n.toLowerCase()] ?? null),
    })
    expect(door).toMatchObject({ status: 403, body: { code: ADMIN_KEY_IN_BROWSER } })

    const { response } = await v1ApiMiddleware(nextReq(legacyKey, BROWSER), { projectId })
    expect(response?.status).toBe(403)
    expect((await response!.json()).error.code).toBe(ADMIN_KEY_IN_BROWSER)

    expect(await getProjectIdFromAuth(expressReq(legacyKey, BROWSER))).toMatchObject({ success: false, code: ADMIN_KEY_IN_BROWSER })

    const res = fakeRes()
    const next = jest.fn()
    await v1AuthMiddleware(expressReq(legacyKey, BROWSER), res, next)
    expect(res.statusCode).toBe(403)
    expect(res.body?.error?.code).toBe(ADMIN_KEY_IN_BROWSER)
    expect(next).not.toHaveBeenCalled()
  })

  it('is always served to a server', async () => {
    process.env.ADMIN_KEYS_SERVER_ONLY_FROM = new Date(Date.now() - 60_000).toISOString()
    expect(await refuseMisplacedKey(`/api/v1/${projectId}/storage/files`, { get: (n: string) => (n === 'x-api-key' ? legacyKey : null) })).toBeNull()
    const { response } = await v1ApiMiddleware(nextReq(legacyKey), { projectId })
    expect(response ?? null).toBeNull()
    expect(await getProjectIdFromAuth(expressReq(legacyKey))).toMatchObject({ success: true, projectId })
  })
})
