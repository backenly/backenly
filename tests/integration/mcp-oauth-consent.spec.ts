/**
 * MCP OAuth consent — the step a person takes in the browser, against a real
 * database and with the runtime's real Request and Response.
 *
 * On production (2026-11-09) Approve did nothing in Chromium. The consent form
 * posted to /api/mcp/oauth/authorize, which answered 303 to the MCP client's
 * redirect_uri, and the console's CSP (`form-action 'self'`, which Chromium
 * also applies to a form submission's redirects) blocked it. The server side
 * was fine: the same form sent outside a browser got its code.
 *
 * The consent page now asks for JSON and navigates itself
 * (app/mcp/authorize/ConsentForm.tsx). This pins the server half of that, and
 * that a plain form post still gets the 303.
 */

import '../helpers/real-web-standard'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { POST as authorizeRoute } from '@/app/api/mcp/oauth/authorize/route'
import { CONFIRM_TYP, signAuthzToken } from '@/lib/mcp/oauth-authz'
import { generateToken } from '@/lib/auth/jwt'
import { hashToken, SCOPE_READ } from '@/lib/mcp/oauth'
import { prisma } from '@/lib/db/prisma'

const REDIRECT = 'http://127.0.0.1:53682/callback'
const ORIGIN = 'https://backenly.test'

let userId: string
let projectId: string
let clientId: string
let session: string

function confirmFor(uid: string, state = 'st-123'): string {
  const verifier = crypto.randomBytes(32).toString('base64url')
  return signAuthzToken(
    {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      scope: SCOPE_READ,
      state,
      uid,
    },
    CONFIRM_TYP,
  )
}

function consentPost(fields: Record<string, string>, opts: { json: boolean; cookie?: string }): NextRequest {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  const headers: Record<string, string> = { cookie: `auth-token=${opts.cookie ?? session}` }
  if (opts.json) headers.accept = 'application/json'
  return new NextRequest(`${ORIGIN}/api/mcp/oauth/authorize`, { method: 'POST', body, headers })
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `oauth-consent-${Date.now()}@probe.local`, name: 'consent probe', updatedAt: new Date() },
  })
  userId = user.id
  projectId = (await prisma.project.create({ data: { name: 'consent probe', userId, updatedAt: new Date() } })).id
  clientId = `client_${crypto.randomBytes(8).toString('hex')}`
  await prisma.mcpOAuthClient.create({
    data: { clientId, clientName: 'Consent probe', redirectUris: [REDIRECT] },
  })
  session = generateToken({ userId, email: user.email })
})

afterAll(async () => {
  await prisma.mcpOAuthCode.deleteMany({ where: { clientId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.mcpOAuthClient.deleteMany({ where: { clientId } }).catch(() => {})
})

describe('the consent page, asking for JSON', () => {
  it('gets the callback to navigate to, with a working code and the state, instead of a redirect the CSP blocks', async () => {
    const res = await authorizeRoute(
      consentPost({ confirm: confirmFor(userId), project_id: projectId, read_only: 'on', decision: 'approve' }, { json: true }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    const { redirectTo } = (await res.json()) as { redirectTo: string }
    const to = new URL(redirectTo)
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT)
    expect(to.searchParams.get('state')).toBe('st-123')
    const code = to.searchParams.get('code')!
    const row = await prisma.mcpOAuthCode.findUnique({ where: { codeHash: hashToken(code) } })
    expect(row?.clientId).toBe(clientId)
    expect(row?.scope).toBe(SCOPE_READ)
  })

  it('a decline is a navigation back to the client with access_denied', async () => {
    const res = await authorizeRoute(
      consentPost({ confirm: confirmFor(userId, 'st-deny'), project_id: projectId, decision: 'deny' }, { json: true }),
    )
    expect(res.status).toBe(200)
    const to = new URL(((await res.json()) as { redirectTo: string }).redirectTo)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('state')).toBe('st-deny')
  })

  it('an error that must not go to the client stays on the page, as JSON it can show', async () => {
    const stranger = generateToken({ userId: crypto.randomUUID(), email: 'stranger@probe.local' })
    const res = await authorizeRoute(
      consentPost({ confirm: confirmFor(userId), project_id: projectId, decision: 'approve' }, { json: true, cookie: stranger }),
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.json()).toEqual({ error: 'Session mismatch', detail: 'Sign in again and retry the connection.' })
  })
})

describe('a plain form post (no JavaScript)', () => {
  it('still gets the 303 to the callback', async () => {
    const res = await authorizeRoute(
      consentPost({ confirm: confirmFor(userId, 'st-form'), project_id: projectId, read_only: 'on', decision: 'approve' }, { json: false }),
    )
    expect(res.status).toBe(303)
    const to = new URL(res.headers.get('location')!)
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT)
    expect(to.searchParams.get('state')).toBe('st-form')
  })
})

describe("the console's CSP", () => {
  it("keeps form-action 'self': the fix navigates, it does not widen where forms may go", async () => {
    const config = require('../../next.config.js')
    const rules = await config.headers()
    const csp = rules
      .flatMap((r: { headers: Array<{ key: string; value: string }> }) => r.headers)
      .find((h: { key: string }) => h.key === 'Content-Security-Policy')
    expect(csp.value).toContain("form-action 'self'")
  })
})
