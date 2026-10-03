/**
 * PHASE 3 — gateway security properties.
 *
 * One PostgREST serves every tenant's schema, and it chooses the schema from a
 * REQUEST HEADER. That makes `Accept-Profile` / `Content-Profile` the single
 * most dangerous input in the system: a client that can influence either one can
 * address another tenant's data. Header stripping is not defence in depth here,
 * it IS the isolation boundary, so it is tested adversarially.
 *
 * The second property is identity. End-user tokens are signed per project, and
 * a single PostgREST has one jwt-secret, so the gateway must re-mint. The tests
 * assert the minted token can only ever say what the SERVER decided — never
 * what the caller asked for.
 */

import jwt from 'jsonwebtoken'
import {
  profileForProject,
  buildUpstreamHeaders,
  internalClaimsFor,
  mintInternalToken,
  verifyInternalToken,
  upstreamUrl,
  INTERNAL_TOKEN_TTL_SECONDS,
} from '@/lib/postgrest/gateway'

const PROJECT = 'ac6b51fd-5ed7-4c00-9938-cff57f34d304'
const OTHER = 'deadbeef-0000-0000-0000-000000000000'
const SECRET = 'test-postgrest-secret'

describe('profileForProject', () => {
  it('maps a project to its own schema', () => {
    expect(profileForProject(PROJECT)).toBe(`workspace_${PROJECT}`)
  })

  it('REFUSES anything that is not a plain identifier', () => {
    // The projectId arrives from a URL path and lands in a header that selects
    // a PostgreSQL schema. Every one of these is an attempt to escape it.
    for (const bad of [
      'a b', 'a"b', "a'b", 'a;b', 'a/b', 'a\\b', 'a\nb',
      'public', // valid identifier, but see the confinement test below
      '', '   ', '../other', 'x'.repeat(64),
    ]) {
      if (bad === 'public') continue
      expect(() => profileForProject(bad)).toThrow()
    }
  })

  it('always confines to the workspace_ namespace', () => {
    // Even a syntactically valid id can only ever produce a workspace_ schema,
    // so `public` or a PostgREST internal schema is unreachable by construction.
    expect(profileForProject('public')).toBe('workspace_public')
  })
})

describe('buildUpstreamHeaders — tenancy isolation', () => {
  const mint = () => mintInternalToken(internalClaimsFor({ projectId: PROJECT }), SECRET)

  it('STRIPS a client-supplied Accept-Profile and substitutes the real one', () => {
    const headers = buildUpstreamHeaders(
      { 'accept-profile': `workspace_${OTHER}`, accept: 'application/json' },
      { projectId: PROJECT, internalToken: mint(), method: 'GET' },
    )
    expect(headers['accept-profile']).toBe(`workspace_${PROJECT}`)
    expect(JSON.stringify(headers)).not.toContain(OTHER)
  })

  it('STRIPS a client-supplied Content-Profile on writes', () => {
    const headers = buildUpstreamHeaders(
      { 'content-profile': `workspace_${OTHER}` },
      { projectId: PROJECT, internalToken: mint(), method: 'POST' },
    )
    expect(headers['content-profile']).toBe(`workspace_${PROJECT}`)
  })

  it('is case-insensitive about the header the attacker sends', () => {
    const headers = buildUpstreamHeaders(
      { 'Accept-Profile': `workspace_${OTHER}`, 'CONTENT-PROFILE': `workspace_${OTHER}` },
      { projectId: PROJECT, internalToken: mint(), method: 'PATCH' },
    )
    expect(headers['accept-profile']).toBe(`workspace_${PROJECT}`)
    expect(headers['content-profile']).toBe(`workspace_${PROJECT}`)
    expect(JSON.stringify(headers)).not.toContain(OTHER)
  })

  it('works against a real Headers object, not just a plain map', () => {
    const h = new Headers()
    h.set('accept-profile', `workspace_${OTHER}`)
    h.set('x-trace', 'keep-me')
    const headers = buildUpstreamHeaders(h, {
      projectId: PROJECT, internalToken: mint(), method: 'GET',
    })
    expect(headers['accept-profile']).toBe(`workspace_${PROJECT}`)
    expect(headers['x-trace']).toBe('keep-me')
  })

  it('never forwards the caller credentials past the trust boundary', () => {
    const headers = buildUpstreamHeaders(
      {
        'x-api-key': 'sk_live_secret',
        'x-user-token': 'end.user.jwt',
        authorization: 'Bearer attacker-supplied',
      },
      { projectId: PROJECT, internalToken: mint(), method: 'GET' },
    )
    expect(JSON.stringify(headers)).not.toContain('sk_live_secret')
    expect(JSON.stringify(headers)).not.toContain('end.user.jwt')
    expect(headers['authorization']).not.toContain('attacker-supplied')
    expect(headers['authorization']).toMatch(/^Bearer /)
  })

  it('does not set Content-Profile on reads', () => {
    const headers = buildUpstreamHeaders({}, {
      projectId: PROJECT, internalToken: mint(), method: 'GET',
    })
    expect(headers['content-profile']).toBeUndefined()
  })

  it('drops hop-by-hop headers', () => {
    const headers = buildUpstreamHeaders(
      { host: 'evil.example', connection: 'keep-alive', 'content-length': '99' },
      { projectId: PROJECT, internalToken: mint(), method: 'POST' },
    )
    expect(headers.host).toBeUndefined()
    expect(headers.connection).toBeUndefined()
    expect(headers['content-length']).toBeUndefined()
  })
})

// ── The framing of the incoming request never reaches PostgREST ─────────────
//
// On AWS every runtime request arrives through Next's forwarder
// (lib/runtime/forward-to-runtime.ts), which streams the body, so writes arrive
// with `transfer-encoding: chunked`. The gateway copied it onto a request whose
// body it had re-serialized itself, undici refused it ("invalid
// transfer-encoding header"), and every /db and /api/v2 write answered 502
// UPSTREAM_UNAVAILABLE while reads worked. Found qualifying v8 on staging.

describe('buildUpstreamHeaders — the incoming framing stays behind', () => {
  const mint = () => mintInternalToken(internalClaimsFor({ projectId: PROJECT }), SECRET)

  it.each([
    'transfer-encoding', 'te', 'trailer', 'upgrade', 'keep-alive',
    'proxy-authenticate', 'proxy-authorization', 'content-encoding', 'expect',
  ])('drops %s', header => {
    const headers = buildUpstreamHeaders(
      { [header]: 'x', 'content-type': 'application/json' },
      { projectId: PROJECT, internalToken: mint(), method: 'POST' },
    )
    expect(headers[header]).toBeUndefined()
    // Non-vacuity: an ordinary header in the same call still goes through.
    expect(headers['content-type']).toBe('application/json')
  })

  it('drops headers the incoming Connection header names as hop-by-hop', () => {
    const headers = buildUpstreamHeaders(
      { connection: 'close, X-Hop-Only', 'x-hop-only': '1', 'x-keep': '2' },
      { projectId: PROJECT, internalToken: mint(), method: 'POST' },
    )
    expect(headers['x-hop-only']).toBeUndefined()
    expect(headers['x-keep']).toBe('2')
  })

  it('is case-insensitive about the framing header too', () => {
    const headers = buildUpstreamHeaders(
      { 'Transfer-Encoding': 'chunked' },
      { projectId: PROJECT, internalToken: mint(), method: 'POST' },
    )
    expect(Object.keys(headers).map(k => k.toLowerCase())).not.toContain('transfer-encoding')
  })

  it('a chunked incoming write reaches a real upstream through real fetch', async () => {
    // The exact failure, end to end: headers as the runtime receives them
    // behind Next, a body the gateway re-serialized, and Node's own fetch.
    // Before the fix this threw "fetch failed" (cause: invalid
    // transfer-encoding header) and never reached the server.
    const http = await import('node:http')
    const seen: { body: string; headers: Record<string, unknown> }[] = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        seen.push({ body, headers: req.headers })
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end('[{"id":1}]')
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    try {
      const port = (server.address() as { port: number }).port
      const headers = buildUpstreamHeaders(
        {
          'transfer-encoding': 'chunked',
          connection: 'keep-alive',
          'content-type': 'application/json',
          'x-api-key': 'proj_live_caller_key',
        },
        { projectId: PROJECT, internalToken: mint(), method: 'POST' },
      )
      const res = await fetch(`http://127.0.0.1:${port}/items`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'first' }),
      })
      expect(res.status).toBe(201)
      expect(seen).toHaveLength(1)
      expect(seen[0].body).toBe('{"title":"first"}')
      expect(seen[0].headers['content-profile']).toBe(`workspace_${PROJECT}`)
      expect(seen[0].headers['x-api-key']).toBeUndefined()
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })
})

describe('internal token', () => {
  it('anon by default — no identity is assumed', () => {
    expect(internalClaimsFor({ projectId: PROJECT })).toMatchObject({ role: 'anon' })
  })

  it('authenticated carries the end-user id as sub', () => {
    const claims = internalClaimsFor({ projectId: PROJECT, endUserId: 'user-1' })
    expect(claims).toMatchObject({ role: 'authenticated', sub: 'user-1' })
  })

  it('service_role comes only from the server flag, never from a user id', () => {
    const claims = internalClaimsFor({ projectId: PROJECT, endUserId: 'user-1', serviceRole: true })
    expect(claims.role).toBe('service_role')
    // A service-role request is not "a user" — leaving sub set would let a
    // policy that checks sub attribute owner-level writes to that end user.
    expect(claims.sub).toBeUndefined()
  })

  it('round-trips and is signed with the shared secret', () => {
    const token = mintInternalToken(internalClaimsFor({ projectId: PROJECT, endUserId: 'u' }), SECRET)
    const decoded = verifyInternalToken(token, SECRET)
    expect(decoded.sub).toBe('u')
    expect(decoded.role).toBe('authenticated')
  })

  it('is rejected when signed with a different secret', () => {
    const token = mintInternalToken(internalClaimsFor({ projectId: PROJECT }), 'other-secret')
    expect(() => verifyInternalToken(token, SECRET)).toThrow()
  })

  it('expires quickly — it is a capability for one request, not a session', () => {
    const token = mintInternalToken(internalClaimsFor({ projectId: PROJECT }), SECRET)
    const { exp, iat } = jwt.decode(token) as any
    expect(exp - iat).toBeLessThanOrEqual(INTERNAL_TOKEN_TTL_SECONDS)
  })

  it('FAILS CLOSED when no secret is configured', () => {
    // An unsigned or default-signed token would still name a role, and
    // PostgREST would honour it.
    expect(() => mintInternalToken(internalClaimsFor({ projectId: PROJECT }), '')).toThrow(
      /POSTGREST_JWT_SECRET/,
    )
  })
})

describe('upstreamUrl', () => {
  it('forwards the PostgREST query grammar untouched', () => {
    const url = upstreamUrl('http://127.0.0.1:3001', 'orders', '?select=*,customers(*)&status=eq.paid')
    expect(url).toBe('http://127.0.0.1:3001/orders?select=*,customers(*)&status=eq.paid')
  })

  it('refuses a table name that is not an identifier', () => {
    for (const bad of ['../admin', 'a/b', 'a b', '', 'a;drop']) {
      expect(() => upstreamUrl('http://x', bad, '')).toThrow()
    }
  })

  it('tolerates a missing query string', () => {
    expect(upstreamUrl('http://x/', 'notes', '')).toBe('http://x/notes')
  })
})
