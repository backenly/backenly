/**
 * AN AGENT'S CREDENTIAL HAS ITS ISSUER'S AUTHORITY, AS IT IS NOW
 * ==============================================================
 * Only a project ADMIN may issue an MCP key (Connect → Agents) or approve an
 * OAuth connection, and either one then acts as that person. So each request
 * checks that the issuer is still an ADMIN of the project: when their role is
 * lowered, or they leave the organization, the key and the connection stop
 * working with ISSUER_NOT_ADMIN, and the connection cannot be refreshed. When
 * the role comes back, so does the credential.
 *
 * End to end on a provisioned project: the key is issued through the console
 * route, the connection through the consent POST and the token route, and each
 * is used through the real /api/mcp/tool route.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})

jest.mock('@cloud/project-access', () => {
  try {
    return jest.requireActual('@/lib/cloud/project-access')
  } catch {
    return {
      async organizationRoleForProject(_projectId: string, organizationId: string | null, userId: string) {
        if (!organizationId) return null
        const { prisma: db } = jest.requireActual('@/lib/db')
        const member = await db.organizationMember.findUnique({
          where: { orgId_userId: { orgId: organizationId, userId } },
          select: { role: true },
        })
        return member?.role ?? null
      },
      async organizationProjectClauses(userId: string) {
        return [
          { organization: { members: { some: { userId, restricted: false } } } },
          { projectMembers: { some: { userId } } },
        ]
      },
    }
  }
})

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { createProvisionedProject } from '@/lib/projects/provision'
import { CONFIRM_TYP, signAuthzToken } from '@/lib/mcp/oauth-authz'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'

const REDIRECT = 'http://localhost:9876/callback'
const b64u = (b: Buffer) => b.toString('base64url')
const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_ENGINE_MODE = process.env.ENGINE_MODE

let ownerId = ''
let issuerId = ''
let issuerSession = ''
let orgId = ''
let projectId = ''
let schema = ''
let clientId = ''
let mcpKey = ''
let accessToken = ''
let refreshToken = ''

type Credential = { key: string } | { bearer: string }
const key = (): Credential => ({ key: mcpKey })
const connection = (): Credential => ({ bearer: accessToken })

async function call(cred: Credential, tool: string, args: Record<string, unknown> = {}) {
  const { POST } = await import('@/app/api/mcp/tool/route')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if ('key' in cred) headers['x-api-key'] = cred.key
  else headers.authorization = `Bearer ${cred.bearer}`
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', { method: 'POST', headers, body: JSON.stringify({ tool, args }) }))
  return { status: res.status, body: (await res.json()) as any }
}

const whoami = (cred: Credential) => call(cred, 'connect', { action: 'whoami' })
const createTable = (cred: Credential, table: string) => call(cred, 'apply_migration', { sql: `CREATE TABLE ${table} (note text)` })
const tableExists = async (table: string) =>
  (await prisma.$queryRawUnsafe<Array<{ t: string | null }>>(`SELECT to_regclass('"${schema}"."${table}"')::text AS t`))[0].t !== null

async function refresh() {
  const { POST } = await import('@/app/api/mcp/oauth/token/route')
  const res: any = await POST({
    text: async () => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  } as any)
  const body = await res.json()
  if (body.refresh_token) {
    refreshToken = body.refresh_token
    accessToken = body.access_token
  }
  return { status: res.status as number, body }
}

const setIssuerRole = (role: 'ADMIN' | 'VIEWER') =>
  prisma.organizationMember.update({ where: { orgId_userId: { orgId, userId: issuerId } }, data: { role } })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js runs suites with ENGINE_MODE=integration, which skips real DDL.
  process.env.ENGINE_MODE = 'runtime'
  resetSingleTenantCache()

  const makeUser = async (label: string) =>
    prisma.user.create({
      data: { email: `issuer-${label}-${crypto.randomBytes(5).toString('hex')}@test.invalid`, name: label },
      select: { id: true, email: true },
    })
  const owner = await makeUser('owner')
  const issuer = await makeUser('admin')
  ownerId = owner.id
  issuerId = issuer.id
  issuerSession = (await createSession(issuer.id, issuer.email, 'user')).token
  orgId = (await prisma.organization.create({ data: { name: `issuer-${crypto.randomBytes(4).toString('hex')}`, ownerId }, select: { id: true } })).id
  await prisma.organizationMember.create({ data: { orgId, userId: ownerId, role: 'OWNER' } })
  await prisma.organizationMember.create({ data: { orgId, userId: issuerId, role: 'ADMIN' } })
  const project = await createProvisionedProject({ name: 'issuer-follows', userId: ownerId, organizationId: orgId })
  projectId = project.id
  schema = project.postgresSchema
  // These agents build on main, as an owner who turned protection off does.
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
  const asIssuer: Record<string, string> = { authorization: `Bearer ${issuerSession}`, accept: 'application/json' }

  // The ADMIN issues an MCP key on Connect → Agents.
  const { POST: issueKey } = await import('@/app/api/projects/[id]/mcp/keys/route')
  const url = `http://localhost:3000/api/projects/${projectId}/mcp/keys`
  const issued: any = await issueKey(
    {
      method: 'POST', url, nextUrl: new URL(url),
      headers: { get: (k: string) => asIssuer[k.toLowerCase()] ?? null },
      cookies: { get: () => undefined },
      json: async () => ({ name: 'laptop' }),
    } as any,
    { params: Promise.resolve({ id: projectId }) },
  )
  expect(issued.status).toBe(200)
  mcpKey = (await issued.json()).rawKey

  // The ADMIN approves an OAuth connection, and the host redeems the code.
  const { POST: register } = await import('@/app/api/mcp/oauth/register/route')
  clientId = (await (await register({ json: async () => ({ client_name: 'Claude Code', redirect_uris: [REDIRECT] }), headers: { get: () => null } } as any)).json()).client_id
  const verifier = b64u(crypto.randomBytes(48))
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest())
  const form = new FormData()
  form.set('confirm', signAuthzToken({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, scope: 'mcp:read mcp:write', uid: issuerId }, CONFIRM_TYP))
  form.set('project_id', projectId)
  form.set('decision', 'approve')
  const { POST: authorize } = await import('@/app/api/mcp/oauth/authorize/route')
  const consent: any = await authorize({ formData: async () => form, headers: { get: (k: string) => asIssuer[k.toLowerCase()] ?? null }, cookies: { get: () => undefined } } as any)
  const code = new URL((await consent.json()).redirectTo).searchParams.get('code')!
  const { POST: token } = await import('@/app/api/mcp/oauth/token/route')
  const tokens: any = await (await token({
    text: async () => new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString(),
  } as any)).json()
  accessToken = tokens.access_token
  refreshToken = tokens.refresh_token
  expect(accessToken).toBeTruthy()
}, 180_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.mcpOAuthClient.deleteMany({ where: { clientId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.organizationMember.deleteMany({ where: { orgId } }).catch(() => {})
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {})
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, issuerId] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, issuerId] } } }).catch(() => {})
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ORIGINAL_ENGINE_MODE === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = ORIGINAL_ENGINE_MODE
  resetSingleTenantCache()
}, 120_000)

it('while the issuer is an ADMIN, the key and the connection work', async () => {
  for (const [cred, table] of [[key(), 'notes_by_key'], [connection(), 'notes_by_connection']] as const) {
    expect((await whoami(cred)).body.ok).not.toBe(false)
    expect((await createTable(cred, table)).body.ok).not.toBe(false)
    expect(await tableExists(table)).toBe(true)
  }
  expect((await refresh()).status).toBe(200)
}, 120_000)

it('when the issuer is demoted to VIEWER, both stop working and the connection cannot be refreshed', async () => {
  await setIssuerRole('VIEWER')
  for (const [cred, table] of [[key(), 'after_demotion_key'], [connection(), 'after_demotion_connection']] as const) {
    const who = await whoami(cred)
    expect(who.status).toBe(401)
    expect(who.body.code).toBe('ISSUER_NOT_ADMIN')
    expect((await createTable(cred, table)).status).toBe(401)
    expect(await tableExists(table)).toBe(false)
  }
  const refused = await refresh()
  expect(refused.status).toBe(400)
  expect(refused.body.error).toBe('invalid_grant')
  expect(refused.body.error_description).toMatch(/no longer an ADMIN/)
}, 120_000)

it('when the issuer is an ADMIN again, both work again', async () => {
  await setIssuerRole('ADMIN')
  expect((await whoami(key())).body.ok).not.toBe(false)
  expect((await whoami(connection())).body.ok).not.toBe(false)
  expect((await refresh()).status).toBe(200)
}, 120_000)

it('when the issuer leaves the organization, both stop working and the connection cannot be refreshed', async () => {
  await prisma.organizationMember.delete({ where: { orgId_userId: { orgId, userId: issuerId } } })
  for (const [cred, table] of [[key(), 'after_removal_key'], [connection(), 'after_removal_connection']] as const) {
    const who = await whoami(cred)
    expect(who.status).toBe(401)
    expect(who.body.code).toBe('ISSUER_NOT_ADMIN')
    expect((await createTable(cred, table)).status).toBe(401)
    expect(await tableExists(table)).toBe(false)
  }
  const refused = await refresh()
  expect(refused.status).toBe(400)
  expect(refused.body.error).toBe('invalid_grant')
}, 120_000)
