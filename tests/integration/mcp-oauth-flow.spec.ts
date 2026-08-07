/**
 * MCP OAuth — the grant, against a real database.
 *
 * The unit spec (tests/unit/mcp-oauth.spec.ts) proves the primitives: PKCE,
 * token typing, redirect matching. This proves what only exists once rows are
 * involved — single-use codes, refresh rotation, reuse revocation, and whether
 * an access token actually resolves to a connection whose read-only flag
 * governs the agent.
 *
 * ── Why requests are hand-rolled ────────────────────────────────────────────
 *
 * jest.setup.js replaces the global `Request`/`Response`/`Headers` with
 * simplified stubs, and `new NextRequest(...)` throws against them ("Cannot set
 * property url"). Rather than change a setup file every suite depends on, the
 * handlers are called with the exact surface they use. That also keeps the test
 * honest about its own boundary: it exercises the OAuth handlers and
 * `authenticateMcp`, not the Next.js runtime.
 *
 * The JSON-RPC route is deliberately NOT driven here — it synthesizes its own
 * NextRequest internally to delegate, which the stubs cannot support. Its 401 +
 * WWW-Authenticate behaviour was verified against a running server instead.
 *
 * The consent step is performed as a direct write, because the browser leg is a
 * login redirect and a form. Everything downstream of consent — the part where
 * a mistake mints a credential — runs through the shipped handlers.
 */

import crypto from 'crypto'
import type { NextRequest } from 'next/server'

import { POST as registerRoute } from '@/app/api/mcp/oauth/register/route'
import { POST as tokenRoute } from '@/app/api/mcp/oauth/token/route'
import { POST as revokeRoute } from '@/app/api/mcp/oauth/revoke/route'
import { authenticateMcp } from '@/lib/mcp/auth'
import { prisma } from '@/lib/db/prisma'
import { generateToken } from '@/lib/auth/jwt'

const REDIRECT = 'http://localhost:9876/callback'
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const b64u = (b: Buffer) => b.toString('base64url')

/** Minimal stand-in exposing only what these handlers touch. */
const jsonReq = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest
const formReq = (params: Record<string, string>) =>
  ({ text: async () => new URLSearchParams(params).toString() }) as unknown as NextRequest
const bearerReq = (token: string) =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? `Bearer ${token}` : null) },
  }) as unknown as NextRequest

const readJson = async (res: any) => JSON.parse(res.body)

describe('MCP OAuth end to end', () => {
  let clientId: string
  let userId: string
  let projectId: string

  beforeAll(async () => {
    const res = await registerRoute(
      jsonReq({ client_name: 'integration probe', redirect_uris: [REDIRECT] }),
    )
    clientId = (await readJson(res)).client_id
    expect(typeof clientId).toBe('string')

    const user = await prisma.user.create({
      data: { email: `oauth-int-${Date.now()}@probe.local`, name: 'probe', updatedAt: new Date() },
    })
    userId = user.id
    const project = await prisma.project.create({
      data: { name: 'oauth probe', userId, updatedAt: new Date() },
    })
    projectId = project.id
  })

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId } })
    await prisma.project.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.mcpOAuthClient.deleteMany({ where: { clientId } })
  })

  /** Exactly what POST /authorize writes once a human approves. */
  async function consent(readOnly: boolean, scope: string) {
    const connection = await prisma.apiKey.create({
      data: {
        name: 'integration probe',
        keyHash: `oauth:${crypto.randomBytes(16).toString('hex')}`,
        keyPrefix: 'mcp_oauth_',
        projectId,
        userId,
        permissions: readOnly ? ['read'] : ['read', 'write', 'admin'],
        keyType: 'mcp_oauth',
        scope: 'mcp',
        serviceRole: true,
        mcpReadOnly: readOnly,
      },
    })
    const verifier = b64u(crypto.randomBytes(48))
    const code = b64u(crypto.randomBytes(32))
    await prisma.mcpOAuthCode.create({
      data: {
        codeHash: sha(code),
        clientId,
        apiKeyId: connection.id,
        redirectUri: REDIRECT,
        codeChallenge: b64u(crypto.createHash('sha256').update(verifier).digest()),
        scope,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    })
    return { code, verifier, connectionId: connection.id }
  }

  const exchange = (code: string, verifier: string) =>
    tokenRoute(
      formReq({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    )

  const refresh = (refresh_token: string) =>
    tokenRoute(formReq({ grant_type: 'refresh_token', refresh_token, client_id: clientId }))

  it('registers a public client and issues no secret', async () => {
    const res = await registerRoute(jsonReq({ client_name: 'x', redirect_uris: [REDIRECT] }))
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.client_secret).toBeUndefined()
    expect(body.token_endpoint_auth_method).toBe('none')
    await prisma.mcpOAuthClient.deleteMany({ where: { clientId: body.client_id } })
  })

  it('refuses to register an off-loopback http redirect', async () => {
    const res = await registerRoute(
      jsonReq({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }),
    )
    expect(res.status).toBe(400)
  })

  it('refuses a code exchange with the wrong PKCE verifier', async () => {
    const { code } = await consent(false, 'mcp:read mcp:write')
    const res = await exchange(code, b64u(crypto.randomBytes(48)))
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('invalid_grant')
  })

  it('exchanges a code once, and only once', async () => {
    const { code, verifier } = await consent(false, 'mcp:read mcp:write')

    const first = await exchange(code, verifier)
    const body = await readJson(first)
    expect(first.status).toBe(200)
    expect(body.token_type).toBe('Bearer')
    expect(typeof body.access_token).toBe('string')
    expect(typeof body.refresh_token).toBe('string')

    // The single-use claim is a conditional UPDATE, so a replay must lose.
    expect((await exchange(code, verifier)).status).toBe(400)
  })

  it('resolves an access token to its connection and project', async () => {
    const { code, verifier, connectionId } = await consent(false, 'mcp:read mcp:write')
    const { access_token } = await readJson(await exchange(code, verifier))

    const auth = await authenticateMcp(bearerReq(access_token))
    expect(auth.success).toBe(true)
    expect(auth.keyId).toBe(connectionId)
    expect(auth.projectId).toBe(projectId)
    expect(auth.readOnly).toBe(false)
  })

  it('marks a read-only grant read-only', async () => {
    const { code, verifier } = await consent(true, 'mcp:read')
    const { access_token } = await readJson(await exchange(code, verifier))

    const auth = await authenticateMcp(bearerReq(access_token))
    expect(auth.success).toBe(true)
    expect(auth.readOnly).toBe(true)
  })

  it('lets scope narrow a read-write connection, never widen it', async () => {
    // A connection that is NOT flagged read-only, but whose token was granted
    // only mcp:read, must still be treated as read-only.
    const { code, verifier } = await consent(false, 'mcp:read')
    const { access_token } = await readJson(await exchange(code, verifier))

    const auth = await authenticateMcp(bearerReq(access_token))
    expect(auth.success).toBe(true)
    expect(auth.readOnly).toBe(true)
  })

  it('rotates the refresh token and burns the chain on reuse', async () => {
    const { code, verifier } = await consent(false, 'mcp:read mcp:write')
    const first = await readJson(await exchange(code, verifier))

    const rotated = await refresh(first.refresh_token)
    const rotatedBody = await readJson(rotated)
    expect(rotated.status).toBe(200)
    expect(rotatedBody.refresh_token).not.toBe(first.refresh_token)

    // Presenting the old one means it leaked — the whole chain must die.
    expect((await refresh(first.refresh_token)).status).toBe(400)
    expect((await refresh(rotatedBody.refresh_token)).status).toBe(400)
  })

  it('kills outstanding access tokens when the connection is revoked', async () => {
    const { code, verifier } = await consent(true, 'mcp:read')
    const tok = await readJson(await exchange(code, verifier))

    expect((await authenticateMcp(bearerReq(tok.access_token))).success).toBe(true)

    await revokeRoute(formReq({ token: tok.refresh_token }))

    // Still cryptographically valid; it just names nothing now.
    const after = await authenticateMcp(bearerReq(tok.access_token))
    expect(after.success).toBe(false)
    expect(after.code).toBe('CONNECTION_REVOKED')
  })

  it('REFUSES a platform session JWT as a Bearer token', async () => {
    // Same secret, same algorithm, valid signature. Only `typ` separates them.
    const platform = generateToken({ userId, email: 'probe@local' })
    const auth = await authenticateMcp(bearerReq(platform))
    expect(auth.success).toBe(false)
    expect(auth.code).toBe('INVALID_TOKEN')
  })
})
