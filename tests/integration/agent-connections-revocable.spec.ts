/**
 * Agent credentials are managed in one place, and disconnecting one ends it
 * (medium findings T4, CON-09).
 *
 * Settings, API keys listed every ApiKey row of the project, so MCP keys and
 * browser-authorised agent connections appeared there labelled "Client", a
 * connection with a masked key it never had. That list is client keys now;
 * Connect, Agents lists and disconnects the agent's credentials. This pins
 * the list, and that the Disconnect the Agents tab now offers, the console's
 * DELETE /mcp/keys/[keyId], truly ends a real OAuth connection: its access
 * token stops authenticating and its refresh token cannot mint another.
 *
 * Real rows and a real token exchange; the consent step is the direct write
 * mcp-oauth-flow.spec.ts uses, because the browser leg is a login redirect.
 * The project-access check on the console route is delegated (pinned
 * elsewhere); the API-keys list authenticates with a real platform session.
 */

jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) =>
    handler({ projectId: (global as any).__PROJECT_ID__, userId: (global as any).__USER_ID__ }),
}))

import crypto from 'crypto'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { authenticateMcp } from '@/lib/mcp/auth'
import { POST as registerRoute } from '@/app/api/mcp/oauth/register/route'
import { POST as tokenRoute } from '@/app/api/mcp/oauth/token/route'
import { GET as listApiKeys } from '@/app/api/api-keys/route'
import { DELETE as revokeAgentCredential } from '@/app/api/projects/[id]/mcp/keys/[keyId]/route'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

const REDIRECT = 'http://localhost:9876/callback'
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const b64u = (b: Buffer) => b.toString('base64url')
const readJson = async (res: any) => (typeof res.body === 'string' ? JSON.parse(res.body) : res.json())

const jsonReq = (body: unknown) =>
  ({
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === 'x-forwarded-for' ? '192.0.2.78' : null) },
  }) as unknown as NextRequest
const formReq = (params: Record<string, string>) =>
  ({ text: async () => new URLSearchParams(params).toString() }) as unknown as NextRequest
const bearerReq = (token: string) =>
  ({ headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? `Bearer ${token}` : null) } }) as unknown as NextRequest

let userId = ''
let projectId = ''
let session = ''
let clientId = ''
let clientKeyId = ''
let mcpKeyId = ''
let connectionId = ''
let tokens: { access_token: string; refresh_token: string }

function sessionReq(path: string, query: string): any {
  return {
    method: 'GET',
    url: `http://localhost:3000${path}${query}`,
    nextUrl: { pathname: path, searchParams: new URLSearchParams(query.replace(/^\?/, '')), origin: 'http://localhost:3000' },
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? `Bearer ${session}` : null) },
    cookies: { get: () => undefined },
  }
}

beforeAll(async () => {
  // A multi-tenant database, as Cloud runs: the access check resolves the
  // project by id rather than as the deployment's only one.
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  const email = `agent-conn-${crypto.randomBytes(6).toString('hex')}@test.invalid`
  userId = (await prisma.user.create({ data: { email, name: 'Agent Connections Test' }, select: { id: true } })).id
  session = (await createSession(userId, email, 'user')).token
  projectId = (await prisma.project.create({ data: { name: 'agent-connections', userId }, select: { id: true } })).id
  ;(global as any).__PROJECT_ID__ = projectId
  ;(global as any).__USER_ID__ = userId

  const keyRow = (scope: string, keyType: string, prefix: string) =>
    prisma.apiKey.create({
      data: {
        name: `${keyType} key`, keyHash: `test:${crypto.randomBytes(16).toString('hex')}`, keyPrefix: prefix,
        projectId, userId, permissions: ['read'], keyType, scope,
      },
      select: { id: true },
    })
  clientKeyId = (await keyRow('runtime', 'public', 'pk_live_abc1')).id
  mcpKeyId = (await keyRow('mcp', 'mcp', 'mcp_live_abc')).id

  // A real OAuth connection: register, consent (the row /authorize writes),
  // then exchange the code for tokens through the real token route.
  clientId = (await readJson(await registerRoute(jsonReq({ client_name: 'Claude Code', redirect_uris: [REDIRECT] })))).client_id
  connectionId = (
    await prisma.apiKey.create({
      data: {
        name: 'Claude Code', keyHash: `oauth:${crypto.randomBytes(16).toString('hex')}`, keyPrefix: 'mcp_oauth_',
        projectId, userId, permissions: ['read'], keyType: 'mcp_oauth', scope: 'mcp', serviceRole: true,
        mcpReadOnly: true, mcpClientLabel: 'Claude Code',
      },
      select: { id: true },
    })
  ).id
  const verifier = b64u(crypto.randomBytes(48))
  const code = b64u(crypto.randomBytes(32))
  await prisma.mcpOAuthCode.create({
    data: {
      codeHash: sha(code), clientId, apiKeyId: connectionId, redirectUri: REDIRECT,
      codeChallenge: b64u(crypto.createHash('sha256').update(verifier).digest()),
      scope: 'mcp:read', expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  })
  tokens = await readJson(
    await tokenRoute(formReq({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier })),
  )
  expect((await authenticateMcp(bearerReq(tokens.access_token))).success).toBe(true)
}, 60_000)

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  resetSingleTenantCache()
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.mcpOAuthClient.deleteMany({ where: { clientId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
}, 60_000)

it('Settings, API keys lists the app’s keys only, never an agent key or connection', async () => {
  const res: any = await listApiKeys(sessionReq('/api/api-keys', `?projectId=${projectId}`))
  expect(res.status).toBe(200)
  const ids = (await readJson(res)).apiKeys.map((k: any) => k.id)
  expect(ids).toContain(clientKeyId)
  expect(ids).not.toContain(mcpKeyId)
  expect(ids).not.toContain(connectionId)
}, 60_000)

it('Disconnect on the Agents tab ends the connection: no access, no refresh', async () => {
  const res: any = await revokeAgentCredential({} as any, { params: Promise.resolve({ id: projectId, keyId: connectionId }) })
  expect(res.status).toBe(200)

  const after = await authenticateMcp(bearerReq(tokens.access_token))
  expect(after.success).toBe(false)

  const refreshed: any = await tokenRoute(formReq({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }))
  expect(refreshed.status).toBeGreaterThanOrEqual(400)
  expect(await prisma.mcpOAuthRefresh.count({ where: { apiKeyId: connectionId } })).toBe(0)
}, 60_000)
