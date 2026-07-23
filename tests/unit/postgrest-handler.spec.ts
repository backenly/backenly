/**
 * The PostgREST request handler, executed end to end against a stubbed upstream.
 *
 * Until now this module had never run — not in a test, not in production, since
 * no project is cut over. Every claim about the translation layer was a claim
 * about translate.ts's unit tests, not about the code that actually calls it.
 * These tests execute the real handler: exposure gate, query translation,
 * upstream call, envelope construction, error mapping.
 *
 * PostgREST itself is stubbed rather than run, so what is verified here is the
 * handler's own behaviour: what it forwards, what it refuses, and what it turns
 * the response into. Whether a live PostgREST agrees is a different question and
 * is what scripts/verify-postgrest-parity.ts exists to answer.
 */

const apiFindFirst = jest.fn()
const queryRawUnsafe = jest.fn()

jest.mock('@/lib/db', () => ({
  prisma: {
    apiDefinition: { findFirst: (...a: unknown[]) => apiFindFirst(...a) },
    $queryRawUnsafe: (...a: unknown[]) => queryRawUnsafe(...a),
  },
}))

import { handleViaPostgrest } from '@/server/routes/postgrest-handler'
import { clearSoftDeleteCache } from '@/lib/postgrest/exposure'

const PROJECT = 'ac6b51fd-5ed7-4c00-9938-cff57f34d304'

interface Captured {
  url: string
  init: RequestInit & { headers: Record<string, string> }
}

let captured: Captured | null = null

function stubUpstream(status: number, body: unknown, headers: Record<string, string> = {}) {
  global.fetch = jest.fn(async (url: string, init: any) => {
    captured = { url: String(url), init }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
  }) as unknown as typeof fetch
}

function mockRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
  return res
}

function mockReq(method: string, query: Record<string, unknown> = {}, body?: unknown) {
  return {
    method,
    query,
    body,
    headers: { 'x-api-key': 'caller-secret', 'user-agent': 'jest' },
  } as any
}

beforeEach(() => {
  jest.clearAllMocks()
  clearSoftDeleteCache()
  captured = null
  process.env.POSTGREST_URL = 'http://127.0.0.1:3002'
  process.env.POSTGREST_JWT_SECRET = 'test-secret-value'
  // Default: table is exposed and has no soft-delete column.
  apiFindFirst.mockResolvedValue({ enabled: true, operations: ['GET', 'POST', 'PATCH', 'DELETE'] })
  queryRawUnsafe.mockResolvedValue([{ n: BigInt(0) }])
  // Stubbed with a throwing mock by default so "did not contact PostgREST"
  // assertions have a mock to inspect — and so any test that unexpectedly
  // reaches the network fails loudly instead of hanging on a real socket.
  global.fetch = jest.fn(async () => {
    throw new Error('unexpected upstream call')
  }) as unknown as typeof fetch
})

describe('exposure gate — runs before anything is forwarded', () => {
  it('404s the users table without contacting PostgREST', async () => {
    // PostgREST would serve this, password column and all. The gate is what the
    // legacy executor provided implicitly by having no ApiDefinition for users.
    const res = mockRes()
    const handled = await handleViaPostgrest(mockReq('GET'), res, ['users'], { projectId: PROJECT })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('404s underscore-prefixed internal tables', async () => {
    const res = mockRes()
    await handleViaPostgrest(mockReq('GET'), res, ['_token_blacklist'], { projectId: PROJECT })
    expect(res.statusCode).toBe(404)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('404s the auth table by name, not by projection', async () => {
    // The denial that must survive every refactor. It is a name check, so no
    // ApiDefinition, cache or projection can be stale in a way that opens it.
    const res = mockRes()
    await handleViaPostgrest(mockReq('GET'), res, ['users'], { projectId: PROJECT })
    expect(res.statusCode).toBe(404)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('forwards a normal table WITHOUT requiring an ApiDefinition', async () => {
    // Changed deliberately 2026-07-21. This used to 404 when no ApiDefinition
    // row existed. ApiDefinition was a second source of truth for a question
    // Postgres already answers, and it could be missing or stale while the table
    // was perfectly reachable — which is how the APIs page ended up advertising
    // CRUD on tables the runtime 404s. The catalog decides what exists; grants
    // and RLS decide who may touch it.
    apiFindFirst.mockResolvedValueOnce(null)
    const res = mockRes()
    await handleViaPostgrest(mockReq('GET'), res, ['orders'], { projectId: PROJECT })
    expect(global.fetch).toHaveBeenCalled()
  })

  it('does not consult ApiDefinition at all', async () => {
    // Guards against the projection creeping back in as a gate. If a future
    // change re-adds the lookup, this fails rather than silently reintroducing
    // a second source of truth.
    apiFindFirst.mockClear()
    const res = mockRes()
    await handleViaPostgrest(mockReq('GET'), res, ['orders'], { projectId: PROJECT })
    expect(apiFindFirst).not.toHaveBeenCalled()
  })

  it('declines paths that are not plain CRUD, leaving them to the legacy executor', async () => {
    const res = mockRes()
    // /orders/search is a sub-resource the legacy executor still owns.
    expect(await handleViaPostgrest(mockReq('GET'), res, ['orders', 'search'], { projectId: PROJECT })).toBe(false)
    expect(await handleViaPostgrest(mockReq('GET'), res, ['a', 'b', 'c'], { projectId: PROJECT })).toBe(false)
  })

  it('refuses an unbounded DELETE', async () => {
    // Without a record id this would delete every row the caller can see.
    const res = mockRes()
    expect(await handleViaPostgrest(mockReq('DELETE'), res, ['orders'], { projectId: PROJECT })).toBe(false)
  })
})

describe('request forwarding', () => {
  it('strips the caller credentials and sets the schema server-side', async () => {
    stubUpstream(200, [])
    const res = mockRes()
    await handleViaPostgrest(mockReq('GET'), res, ['orders'], { projectId: PROJECT })

    const h = captured!.init.headers
    // Accept-Profile IS the isolation boundary. A caller-supplied value would
    // select another tenant's schema.
    expect(h['accept-profile']).toBe(`workspace_${PROJECT}`)
    expect(h['x-api-key']).toBeUndefined()
    expect(h['authorization']).toMatch(/^Bearer /)
    expect(h['authorization']).not.toContain('caller-secret')
  })

  it('asks for an exact count so pagination totals are real', async () => {
    stubUpstream(200, [])
    await handleViaPostgrest(mockReq('GET'), mockRes(), ['orders'], { projectId: PROJECT })
    expect(captured!.init.headers['prefer']).toContain('count=exact')
  })

  it('sets Content-Profile on writes, not only Accept-Profile', async () => {
    // PostgREST reads Content-Profile for mutations; setting only the former
    // would point writes at the default schema while reads were correctly scoped.
    stubUpstream(201, [{ id: 1 }])
    await handleViaPostgrest(mockReq('POST', {}, { name: 'x' }), mockRes(), ['orders'], { projectId: PROJECT })
    expect(captured!.init.headers['content-profile']).toBe(`workspace_${PROJECT}`)
  })

  it('translates a filter into PostgREST operator syntax', async () => {
    stubUpstream(200, [])
    await handleViaPostgrest(mockReq('GET', { status: 'paid' }), mockRes(), ['orders'], { projectId: PROJECT })
    expect(captured!.url).toContain('status=eq.paid')
  })

  it('adds the soft-delete predicate when the table has deleted_at', async () => {
    // The leak that a transparent proxy would have introduced: PostgREST has no
    // concept of soft deletion, so without this every deleted row becomes visible.
    queryRawUnsafe.mockResolvedValue([{ n: BigInt(1) }])
    stubUpstream(200, [])
    await handleViaPostgrest(mockReq('GET'), mockRes(), ['orders'], { projectId: PROJECT })
    expect(captured!.url).toContain('deleted_at=is.null')
  })

  it('scopes an update to the record id, never to caller-supplied filters', async () => {
    // A crafted query string must not widen a single-row update into a
    // table-wide one.
    queryRawUnsafe.mockResolvedValue([{ n: BigInt(0) }])
    stubUpstream(200, [{ id: 7 }])
    await handleViaPostgrest(
      mockReq('PATCH', { status: 'anything' }, { name: 'x' }),
      mockRes(),
      ['orders', '7'],
      { projectId: PROJECT },
    )
    expect(captured!.url).toContain('id=eq.7')
    expect(captured!.url).not.toContain('status=eq.anything')
  })

  it('mints service_role only from a server decision', async () => {
    stubUpstream(200, [])
    await handleViaPostgrest(mockReq('GET'), mockRes(), ['orders'], {
      projectId: PROJECT,
      isServiceRole: true,
    })
    const token = captured!.init.headers['authorization'].replace('Bearer ', '')
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(claims.role).toBe('service_role')
    // service_role carries no subject — it is not acting as any end user.
    expect(claims.sub).toBeUndefined()
  })

  it('mints an authenticated role carrying the end-user id', async () => {
    stubUpstream(200, [])
    await handleViaPostgrest(mockReq('GET'), mockRes(), ['orders'], {
      projectId: PROJECT,
      endUserId: 'user-123',
    })
    const token = captured!.init.headers['authorization'].replace('Bearer ', '')
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(claims.role).toBe('authenticated')
    expect(claims.sub).toBe('user-123')
  })
})

describe('response translation', () => {
  it('wraps a list in the legacy {data,pagination} envelope', async () => {
    stubUpstream(200, [{ id: 1 }, { id: 2 }], { 'content-range': '0-1/57' })
    const res = mockRes()
    await handleViaPostgrest(mockReq('GET', { limit: '2' }), res, ['orders'], { projectId: PROJECT })
    expect(res.statusCode).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.pagination).toEqual({ total: 57, limit: 2, offset: 0, hasMore: true, nextCursor: 2 })
  })

  it('unwraps a single record and 404s when absent', async () => {
    stubUpstream(200, [{ id: 7, name: 'x' }])
    const found = mockRes()
    await handleViaPostgrest(mockReq('GET'), found, ['orders', '7'], { projectId: PROJECT })
    expect(found.body.data).toEqual({ id: 7, name: 'x' })

    stubUpstream(200, [])
    const missing = mockRes()
    await handleViaPostgrest(mockReq('GET'), missing, ['orders', '7'], { projectId: PROJECT })
    expect(missing.statusCode).toBe(404)
  })

  it('returns 201 with the legacy message on create', async () => {
    stubUpstream(201, [{ id: 9 }])
    const res = mockRes()
    await handleViaPostgrest(mockReq('POST', {}, { name: 'x' }), res, ['orders'], { projectId: PROJECT })
    expect(res.statusCode).toBe(201)
    expect(res.body.message).toBe('Record created successfully')
  })

  it('404s an update that matched nothing, without revealing whether RLS hid it', async () => {
    stubUpstream(200, [])
    const res = mockRes()
    await handleViaPostgrest(mockReq('PATCH', {}, { a: 1 }), res, ['orders', '7'], { projectId: PROJECT })
    expect(res.statusCode).toBe(404)
  })
})

describe('error handling', () => {
  it('maps a unique violation to 409', async () => {
    stubUpstream(400, { code: '23505', message: 'duplicate key' })
    const res = mockRes()
    await handleViaPostgrest(mockReq('POST', {}, {}), res, ['orders'], { projectId: PROJECT })
    expect(res.statusCode).toBe(409)
  })

  it('never echoes PostgREST wording on a privilege error', async () => {
    // "permission denied for table users" names a table the caller was not
    // meant to learn exists.
    stubUpstream(403, { code: '42501', message: 'permission denied for table users' })
    const res = mockRes()
    await handleViaPostgrest(mockReq('GET'), res, ['orders'], { projectId: PROJECT })
    expect(JSON.stringify(res.body)).not.toMatch(/users|permission denied/i)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('returns 502 when the upstream is unreachable', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const res = mockRes()
    await handleViaPostgrest(mockReq('GET'), res, ['orders'], { projectId: PROJECT })
    expect(res.statusCode).toBe(502)
    expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE')
  })

  it('returns 504 when the upstream times out', async () => {
    global.fetch = jest.fn(async () => {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e
    }) as unknown as typeof fetch
    const res = mockRes()
    await handleViaPostgrest(mockReq('GET'), res, ['orders'], { projectId: PROJECT })
    expect(res.statusCode).toBe(504)
  })
})

describe('configuration guards', () => {
  it('declines when PostgREST is not configured, so the legacy path runs', async () => {
    delete process.env.POSTGREST_JWT_SECRET
    const res = mockRes()
    expect(await handleViaPostgrest(mockReq('GET'), res, ['orders'], { projectId: PROJECT })).toBe(false)
  })
})
