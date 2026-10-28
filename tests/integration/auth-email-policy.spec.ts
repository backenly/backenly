/**
 * The auth email policy is reachable from both doors, and neither can strand
 * new users (medium finding AUTH-F11).
 *
 * ProjectAuthConfig (app name, app URL, requireEmailVerification,
 * magicLinksEnabled) is read on every sign-up and sign-in, and a working route
 * existed to set it, but nothing called that route and no agent action wrote
 * it. Both doors now go through lib/services/auth-email-policy.ts, which adds
 * the one guard the setting needs: sign-in refuses an unverified address while
 * verification is required, so turning it on with no sender would leave every
 * new user waiting for an email that is never sent.
 *
 * Every call is real: the MCP route with real keys for the agent door, the
 * console route with a real session cookie for the other, and the runtime's own
 * reader (getAuthEmailContext) for what sign-in will actually do.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})

import '../helpers/next-request-polyfill'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createSession } from '@/lib/auth/session'
import { POST as mcpPost } from '@/app/api/mcp/tool/route'
import { PUT as consolePut } from '@/app/api/projects/[id]/auth-email-settings/route'
import { getSmtpConfigView, saveSmtpConfig } from '@/lib/email/project-smtp'
import { getAuthEmailContext } from '@/lib/services/end-user-auth-email'
import { removeSmtp } from '@/lib/email/agent-actions'

const ROOT = process.cwd()
const RW_KEY = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
const RO_KEY = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
const DEPLOYMENT_SMTP = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const

let ownerId: string
let ownerEmail: string
let projectId: string
let schema: string
const savedEnv: Record<string, string | undefined> = {}
const originalEdition = process.env.BACKENLY_EDITION

async function agent(key: string, args: Record<string, unknown>) {
  const res = await mcpPost(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ tool: 'auth', args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function console_(body: Record<string, unknown>) {
  const { token } = await createSession(ownerId, ownerEmail, 'user')
  const res = await consolePut(
    new NextRequest(`https://backenly.test/api/projects/${projectId}/auth-email-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: `auth-token=${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: projectId }) },
  )
  return { status: res.status, body: await res.json() as any }
}

async function mintKey(raw: string, readOnly: boolean) {
  await prisma.apiKey.create({
    data: {
      name: readOnly ? 'agent (read-only)' : 'agent',
      keyPrefix: raw.slice(0, 12),
      keyHash: hashApiKey(raw),
      userId: ownerId,
      projectId,
      scope: 'mcp',
      mcpReadOnly: readOnly,
      permissions: [],
      capabilities: [],
    },
  })
}

const storedPolicy = () => prisma.projectAuthConfig.findUnique({ where: { projectId } })

async function verifiedColumn(): Promise<{ column_default: string | null } | undefined> {
  const rows = await prisma.$queryRawUnsafe<{ column_default: string | null }[]>(
    `SELECT column_default FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'email_verified'`,
    schema,
  )
  return rows[0]
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // No deployment fallback: the guard is about whether ANY sender is active.
  for (const k of DEPLOYMENT_SMTP) { savedEnv[k] = process.env[k]; delete process.env[k] }

  ownerEmail = `auth-policy-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'policy' } })).id
  projectId = (await prisma.project.create({ data: { name: 'auth-policy-app', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."users" (id serial PRIMARY KEY, email text UNIQUE NOT NULL)`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."users" (email) VALUES ('existing@example.test')`)
  await mintKey(RW_KEY, false)
  await mintKey(RO_KEY, true)
}, 120_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  for (const k of DEPLOYMENT_SMTP) { if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k] }
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('AUTH-F11: the agent can read and set the policy', () => {
  it('email_settings reports the policy, with the effective fallbacks, to a read-only key', async () => {
    const r = await agent(RO_KEY, { action: 'email_settings' })
    expect(r.body.ok).toBe(true)
    expect(r.body.data.policy).toMatchObject({
      appName: null, requireEmailVerification: false, magicLinksEnabled: true, effectiveAppName: 'auth-policy-app',
    })
    expect(r.body.summary).toContain('does not require a verified email')
  }, 60_000)

  it('a read-only key cannot change it', async () => {
    const r = await agent(RO_KEY, { action: 'set_email_policy', magicLinksEnabled: false })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('READ_ONLY_KEY')
    expect(await storedPolicy()).toBeNull()
  }, 60_000)

  it('refuses an empty call and a bad URL, saving nothing', async () => {
    const empty = await agent(RW_KEY, { action: 'set_email_policy' })
    expect(empty.body).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    const badUrl = await agent(RW_KEY, { action: 'set_email_policy', appUrl: 'not a url' })
    expect(badUrl.body).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(await storedPolicy()).toBeNull()
  }, 60_000)

  it('saves what it is given, and sign-in reads exactly that', async () => {
    const r = await agent(RW_KEY, {
      action: 'set_email_policy', appName: 'Acme', appUrl: 'https://acme.example.test', magicLinksEnabled: false,
    })
    expect(r.body.ok).toBe(true)
    expect(await storedPolicy()).toMatchObject({ appName: 'Acme', appUrl: 'https://acme.example.test', magicLinksEnabled: false })
    await expect(getAuthEmailContext(projectId)).resolves.toMatchObject({
      appName: 'Acme', appUrl: 'https://acme.example.test', magicLinksEnabled: false, requireEmailVerification: false,
    })
  }, 60_000)
})

describe('AUTH-F11: verification cannot be turned on with nobody to send the email', () => {
  it('precondition: no sender is active', async () => {
    expect((await getSmtpConfigView(projectId)).activeSource).toBe('none')
  }, 60_000)

  it('the agent door refuses, changes nothing, and adds no column', async () => {
    const r = await agent(RW_KEY, { action: 'set_email_policy', requireEmailVerification: true })
    expect(r.body).toMatchObject({ ok: false, code: 'NO_EMAIL_SENDER' })
    expect((await storedPolicy())?.requireEmailVerification).toBe(false)
    expect(await verifiedColumn()).toBeUndefined()
  }, 60_000)

  it('the console door refuses the same way, with a 409 in the same words', async () => {
    const r = await console_({ requireEmailVerification: true })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('NO_EMAIL_SENDER')
    expect((await storedPolicy())?.requireEmailVerification).toBe(false)
  }, 60_000)

  it('with a sender, it turns on and the users who already exist stay able to sign in', async () => {
    await saveSmtpConfig(projectId, {
      host: 'smtp.example.test', port: 587, username: 'mailer',
      password: ['test', 'only', crypto.randomBytes(8).toString('hex')].join('-'),
      fromAddress: 'auth@example.test', enabled: true,
    })
    expect((await getSmtpConfigView(projectId)).activeSource).toBe('project')

    const r = await console_({ requireEmailVerification: true })
    expect(r.status).toBe(200)
    expect(r.body.settings.requireEmailVerification).toBe(true)

    const existing = await prisma.$queryRawUnsafe<{ email_verified: boolean }[]>(
      `SELECT email_verified FROM "${schema}"."users" WHERE email = 'existing@example.test'`,
    )
    expect(existing[0].email_verified).toBe(true)
    expect((await verifiedColumn())?.column_default).toBe('false')
  }, 60_000)
})

describe('AUTH-F11: a project already requiring verification is not wedged', () => {
  it('removing the sender says new users are now stranded, and how to fix it', async () => {
    const r = await removeSmtp({ userId: ownerId, projectId })
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('new users can no longer sign in')
    expect(r.summary).toContain('set_email_policy')
  }, 60_000)

  it('the console form, which re-sends the flag, can still save the app name', async () => {
    const r = await console_({ appName: 'Acme 2', requireEmailVerification: true, magicLinksEnabled: false })
    expect(r.status).toBe(200)
    expect(r.body.settings).toMatchObject({ appName: 'Acme 2', requireEmailVerification: true })
  }, 60_000)

  it('the agent can turn verification off again without a sender', async () => {
    const r = await agent(RW_KEY, { action: 'set_email_policy', requireEmailVerification: false })
    expect(r.body.ok).toBe(true)
    await expect(getAuthEmailContext(projectId)).resolves.toMatchObject({ requireEmailVerification: false })
  }, 60_000)
})

describe('AUTH-F11: the console renders and saves the policy', () => {
  it('the Auth page panel reads and writes the policy route', () => {
    const panel = fs.readFileSync(path.join(ROOT, 'components', 'auth', 'EmailSettingsPanel.tsx'), 'utf8')
    expect(panel).toContain('/auth-email-settings')
    expect(panel).toMatch(/method: 'PUT'[\s\S]*requireEmailVerification/)
  })
})
