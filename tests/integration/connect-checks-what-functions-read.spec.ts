/**
 * CONNECTING TWILIO, OR A KEY AS "email", GIVES FUNCTIONS WHAT THE REPLY SAYS (#612)
 * ===============================================================================
 * Connecting Twilio asked for "AC... (Account SID) + auth token", stored
 * whatever came, and replied that functions could use ctx.integrations.twilio.*,
 * which the runtime builds only from accountSid:authToken:fromNumber: every SMS
 * function threw a TypeError. A key connected as "email" was stored under an
 * id the runtime never reads and replied "email connected", and the refusal of
 * an unknown id listed "email" among the providers.
 *
 * Here the agent's connect runs as the integrations tool sends it
 * (store_integration_key through TOOL_TO_ACTION and executeAction), with a real
 * vault, and the runtime builds ctx.integrations from what was stored. Only
 * the providers' answers are stood in for. The shape check and Twilio's probe,
 * case by case: tests/unit/connect-checks-what-functions-read.spec.ts.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { encrypt } from '@/lib/services/encryption'
import { executeAction } from '@/lib/ai/minimal-executor'
import { TOOL_TO_ACTION } from '@/lib/ai/brain/tools'
import { getIntegrationKey } from '@/lib/services/integrationKeyStore'
import { buildIntegrationContext } from '@/lib/services/ai-functions/integration-context'
import { integrationCapabilities, verifyIntegration } from '@/lib/integrations/agent-actions'
import { checkIntegrationReadiness } from '@/lib/integrations/readiness'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

// Built at runtime, so no credential-shaped literal sits in the repository.
const SID = `AC${crypto.randomBytes(16).toString('hex')}`
const TOKEN = crypto.randomBytes(16).toString('hex')
const FROM = '+15550001111'
const RESEND_KEY = `re_${crypto.randomBytes(12).toString('hex')}`

/** What each provider answers, by the exact URL asked. */
const ANSWERS: Record<string, unknown> = {
  [`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`]: { sid: SID, status: 'active' },
  [`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`]: { sid: 'SM1', status: 'queued' },
  'https://api.resend.com/domains': { data: [] },
}
const asked: Array<{ url: string; init: any }> = []
const realFetch = global.fetch

let userId = ''
const projectIds: string[] = []

async function freshProject(name: string): Promise<string> {
  const id = (await prisma.project.create({ data: { name, userId }, select: { id: true } })).id
  projectIds.push(id)
  return id
}

/** integrations { action: "connect", … }, as the tool hands it to the executor. */
function connect(projectId: string, args: Record<string, unknown>) {
  return executeAction(TOOL_TO_ACTION.store_integration_key(args), projectId, undefined, 0, undefined, false)
}

async function vaultIds(projectId: string): Promise<string[]> {
  const rows = await prisma.projectIntegrationKey.findMany({ where: { projectId }, select: { integrationId: true } })
  return rows.map((r) => r.integrationId).sort()
}

/** A row as connect filed it before this check. */
async function seedRow(projectId: string, integrationId: string, value: string): Promise<void> {
  await prisma.projectIntegrationKey.create({
    data: { projectId, integrationId, encryptedKey: encrypt(value), maskedKey: `${value.slice(0, 7)}…${value.slice(-4)}`, verification: 'unverifiable' },
  })
}

beforeAll(async () => {
  assertSafeTestDatabase()
  userId = (await prisma.user.create({
    data: { email: `connect-shapes-${crypto.randomBytes(6).toString('hex')}@example.test`, name: 'Connect shapes' },
    select: { id: true },
  })).id
}, 60_000)

beforeEach(() => {
  asked.length = 0
  global.fetch = jest.fn(async (input: any, init?: any) => {
    const url = String(input)
    asked.push({ url, init })
    if (!(url in ANSWERS)) throw new Error(`unexpected request to ${url}`)
    const body = ANSWERS[url]
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }) as any
})

afterAll(async () => {
  global.fetch = realFetch
  await prisma.projectIntegrationKey.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {})
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

describe('connecting Twilio', () => {
  it('stores its three parts, as Twilio confirms them, and a function sends SMS with them', async () => {
    const projectId = await freshProject('connect-twilio')

    const out = await connect(projectId, { integrationId: 'twilio', accountSid: SID, authToken: TOKEN, fromNumber: FROM })

    expect(out.success).toBe(true)
    expect(out.message).toMatch(/^twilio connected\. Key stored securely/)
    expect(out.message).toContain(`Functions can now send SMS from ${FROM} with \`ctx.integrations.twilio.sendSms({ to, body })\`.`)
    expect((out.data as any).verification).toBe('verified')
    expect(asked.map((a) => a.url)).toEqual([`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`])
    expect(await getIntegrationKey(projectId, 'twilio')).toBe(`${SID}:${TOKEN}:${FROM}`)

    const ctx = await buildIntegrationContext(projectId)
    await expect(ctx.twilio!.sendSms({ to: '+15550002222', body: 'Your order shipped' })).resolves.toEqual({ sid: 'SM1', status: 'queued' })
    const sent = asked[asked.length - 1]
    expect(sent.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`)
    expect(Object.fromEntries(new URLSearchParams(sent.init.body))).toEqual({ To: '+15550002222', From: FROM, Body: 'Your order shipped' })
  }, 60_000)

  it('refuses the Account SID and auth token alone, which the prompt used to ask for, and stores nothing', async () => {
    const projectId = await freshProject('connect-twilio-two-parts')

    const out = await connect(projectId, { integrationId: 'twilio', apiKey: `${SID}:${TOKEN}` })

    expect(out).toMatchObject({ success: false, error: 'INTEGRATION_KEY_FORMAT' })
    expect(out.message).toMatch(/^\*\*twilio was not connected\.\*\* Twilio's credential is three values, stored as accountSid:authToken:fromNumber/)
    expect(await vaultIds(projectId)).toEqual([])
    expect(asked).toEqual([])
  }, 60_000)

  it('names the sending number when the three parts come without it', async () => {
    const projectId = await freshProject('connect-twilio-no-from')

    const out = await connect(projectId, { integrationId: 'sms', accountSid: SID, authToken: TOKEN })

    expect(out).toMatchObject({ success: false, error: 'INTEGRATION_KEY_FORMAT' })
    expect(out.message).toMatch(/^\*\*twilio was not connected\.\*\* The number SMS is sent from must be/)
    expect(await vaultIds(projectId)).toEqual([])
  }, 60_000)

  it('asks for the Account SID, auth token and sending number when none is given', async () => {
    const projectId = await freshProject('connect-twilio-pending')

    const out = await connect(projectId, { integrationId: 'twilio' })

    expect(out).toMatchObject({ success: false, error: 'CREDENTIALS_PENDING' })
    expect(out.message).toContain('Example format: `AC...:your-auth-token:+15550001111`')
    expect(out.message).toContain('Give them as `accountSid`, `authToken` and `fromNumber`')
  }, 60_000)
})

describe('a key connected as "email"', () => {
  it('is stored as resend when it is a Resend key, which ctx.integrations.email sends with', async () => {
    const projectId = await freshProject('connect-email-resend')

    const out = await connect(projectId, { integrationId: 'email', apiKey: RESEND_KEY })

    expect(out.success).toBe(true)
    expect(out.message).toMatch(/^resend connected\. Key stored securely \([^)]*\)\.\n\nThat is a Resend key, so it is stored as resend, which `ctx\.integrations\.email\.send\(\)` sends with\./)
    expect(await vaultIds(projectId)).toEqual(['resend'])
    const ctx = await buildIntegrationContext(projectId)
    expect(typeof ctx.email?.send).toBe('function')
    expect(ctx.isConnected('email')).toBe(true)
  }, 60_000)

  it('is refused when it is neither, and nothing is stored', async () => {
    const projectId = await freshProject('connect-email-other')

    const out = await connect(projectId, { integrationId: 'email', apiKey: `sk-${crypto.randomBytes(12).toString('hex')}` })

    expect(out).toMatchObject({ success: false, error: 'EMAIL_PROVIDER_REQUIRED' })
    expect(out.message).toMatch(/^\*\*email was not connected\.\*\* Email is sent through Resend or SendGrid/)
    expect(await vaultIds(projectId)).toEqual([])
    expect(asked).toEqual([])
  }, 60_000)

  it('is not offered when an id is unknown', async () => {
    const projectId = await freshProject('connect-unknown')

    const out = await connect(projectId, { integrationId: 'hubspot', apiKey: crypto.randomBytes(16).toString('hex') })

    expect(out).toMatchObject({ success: false, error: 'UNKNOWN_INTEGRATION' })
    const known = /Known providers: (.*)\.$/.exec(out.message)![1].split(', ')
    expect(known).toEqual(expect.arrayContaining(['resend', 'sendgrid', 'twilio']))
    expect(known).not.toContain('email')
  }, 60_000)
})

describe('a credential stored before the check', () => {
  it('gives an SMS function a reason, not a TypeError, and a re-check rejects it', async () => {
    const projectId = await freshProject('legacy-twilio')
    await seedRow(projectId, 'twilio', `${SID}:${TOKEN}`)

    const ctx = await buildIntegrationContext(projectId)
    await expect(ctx.twilio!.sendSms({ to: '+15550002222', body: 'hi' })).rejects.toThrow(/^Twilio cannot send: its stored credential is not accountSid:authToken:fromNumber\./)

    const verified = await verifyIntegration(projectId, { integrationId: 'twilio' })
    expect(verified).toMatchObject({ ok: false, code: 'KEY_REJECTED' })
    expect(verified.summary).toMatch(/: rejected by the provider\. Twilio's credential is three values/)
    const readiness = await checkIntegrationReadiness(projectId, 'twilio')
    expect(readiness.blocking).toEqual([expect.stringMatching(/^Twilio SMS API key was REJECTED by the provider — Twilio's credential is three values/)])
    const caps = await integrationCapabilities(projectId, { integrationId: 'twilio' })
    expect((caps.data as any).providers[0].verification).toBe('rejected')
    expect(asked).toEqual([])
  }, 60_000)

  it('lists a key stored as "email" as read by nothing', async () => {
    const projectId = await freshProject('legacy-email')
    await seedRow(projectId, 'email', RESEND_KEY)

    const listed = await executeAction({ action: 'LIST_INTEGRATION_KEYS', params: {} } as any, projectId, undefined, 0, undefined, false)

    expect(listed.message).toContain('⚠ **email** — Not connected: a key stored as "email" is read by nothing.')
    expect(listed.message).toContain('To send email, connect it again as `resend` (re_…) or `sendgrid` (SG.…).')
  }, 60_000)
})
