/**
 * A KEY IS STORED IN THE SHAPE FUNCTIONS READ IT IN, OR NOT AT ALL (#612)
 * ======================================================================
 * Two connects reported success for a credential no function could use:
 *
 *   Twilio           the runtime builds ctx.integrations.twilio only from
 *                    accountSid:authToken:fromNumber, and the connect prompt
 *                    asked for "AC... (Account SID) + auth token". Nothing
 *                    checked the value, Twilio was never asked, and the
 *                    generator documented twilio.sendSms to new functions,
 *                    which then threw a TypeError
 *   "email"          a key connected as "email" was filed under a vault id
 *                    the runtime never reads (it reads resend and sendgrid)
 *
 * Here: the shape check every way of storing a Twilio key now runs, the
 * vault's refusal of "email", Twilio's own answer about the account, and the
 * runtime's helper for a value stored before the check. The connect itself,
 * through the agent's tool, a real vault and the runtime:
 * tests/integration/connect-checks-what-functions-read.spec.ts.
 */

import crypto from 'crypto'

const mockStored: Record<string, string | null> = {}
jest.mock('@/lib/services/integrationKeyStore', () => ({
  ...jest.requireActual('@/lib/services/integrationKeyStore'),
  getIntegrationKey: jest.fn(async (_projectId: string, id: string) => mockStored[id] ?? null),
}))

import {
  joinTwilioCredential,
  twilioCredentialParts,
  twilioCredentialProblem,
} from '@/lib/integrations/twilio-credential'
import { checkIntegrationKey, EMAIL_IS_NOT_A_KEY } from '@/lib/services/integrationKeyStore'
import { verifyIntegrationKey } from '@/lib/integrations/key-verification'
import { buildIntegrationContext } from '@/lib/services/ai-functions/integration-context'

// Built at runtime, so no credential-shaped literal sits in the repository.
const SID = `AC${crypto.randomBytes(16).toString('hex')}`
const TOKEN = crypto.randomBytes(16).toString('hex')
const FROM = '+15550001111'
const CREDENTIAL = `${SID}:${TOKEN}:${FROM}`

/** What fetch answers, as the code reading it uses it. */
const answer = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

const realFetch = global.fetch
let fetchMock: jest.Mock
beforeEach(() => {
  for (const k of Object.keys(mockStored)) delete mockStored[k]
  fetchMock = jest.fn(async () => answer(200, { sid: 'SM1', status: 'queued' }))
  global.fetch = fetchMock as any
})
afterAll(() => {
  global.fetch = realFetch
})

describe("Twilio's credential", () => {
  it.each([
    ['a phone number', FROM],
    ['a short code', '45678'],
    ['an alphanumeric sender ID', 'Backenly'],
  ])('is accountSid:authToken:fromNumber, sent from %s', (_label, from) => {
    expect(twilioCredentialProblem(`${SID}:${TOKEN}:${from}`)).toBeNull()
  })

  it('refuses the SID and token alone, the shape the connect prompt used to ask for, and says what it needs', () => {
    expect(twilioCredentialProblem(`${SID}:${TOKEN}`)).toBe(
      "Twilio's credential is three values, stored as accountSid:authToken:fromNumber: the Account SID, the auth token " +
        'and the number SMS is sent from, all in the Twilio Console (e.g. AC…:your-auth-token:+15550001111). This value has 2 parts.',
    )
    expect(twilioCredentialProblem(TOKEN)).toMatch(/This value has one part\.$/)
  })

  it('names the part that is wrong', () => {
    expect(twilioCredentialProblem(`SK${SID.slice(2)}:${TOKEN}:${FROM}`)).toMatch(/^The Twilio Account SID is AC followed by 32 hexadecimal/)
    expect(twilioCredentialProblem(`${SID}:not-a-token:${FROM}`)).toMatch(/^The Twilio auth token is 32 hexadecimal/)
    expect(twilioCredentialProblem(`${SID}:${TOKEN}:+1-555-000-1111`)).toMatch(/^The number SMS is sent from must be/)
    // A Messaging Service SID is not a From value the runtime can send with.
    expect(twilioCredentialProblem(`${SID}:${TOKEN}:MG${TOKEN}`)).toMatch(/^The number SMS is sent from must be/)
    expect(twilioCredentialProblem(`${SID}:${TOKEN}:whatsapp:${FROM}`)).toMatch(/This value has 4 parts\.$/)
  })

  it('is assembled from its three parts, a missing one left empty so the check names it', () => {
    expect(joinTwilioCredential({ accountSid: ` ${SID} `, authToken: TOKEN, fromNumber: FROM })).toBe(CREDENTIAL)
    expect(joinTwilioCredential({ accountSid: SID, authToken: TOKEN })).toBe(`${SID}:${TOKEN}:`)
    expect(twilioCredentialProblem(joinTwilioCredential({ accountSid: SID, authToken: TOKEN })!)).toMatch(/^The number SMS is sent from/)
    expect(joinTwilioCredential({})).toBeNull()
  })

  it('is read by the runtime only when all three parts are there', () => {
    expect(twilioCredentialParts(CREDENTIAL)).toEqual({ accountSid: SID, authToken: TOKEN, fromNumber: FROM })
    expect(twilioCredentialParts(`${SID}:${TOKEN}`)).toBeNull()
    expect(twilioCredentialParts(`${SID}::${FROM}`)).toBeNull()
  })
})

describe('the checks a key passes before it is stored', () => {
  it('refuse a Twilio value without its three parts, before Twilio is asked', async () => {
    const out = await checkIntegrationKey('twilio', `${SID}:${TOKEN}`)
    expect(out).toMatchObject({ ok: false, vaultId: 'twilio', isFormatError: true })
    expect((out as any).error).toMatch(/This value has 2 parts\.$/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuse it under the name the console stores it by too', async () => {
    const out = await checkIntegrationKey('TWILIO_CREDENTIALS', `${SID}:${TOKEN}`)
    expect(out).toMatchObject({ ok: false, vaultId: 'twilio', isFormatError: true })
  })

  it('ask Twilio about the account the credential names, and store what it accepts as verified', async () => {
    const out = await checkIntegrationKey('twilio', CREDENTIAL)
    expect(out).toMatchObject({ ok: true, vaultId: 'twilio', verification: { status: 'verified', detail: 'Twilio accepted this key.' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`)
    expect(init.headers).toEqual({ Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}` })
  })

  it('refuse a credential Twilio rejects', async () => {
    fetchMock.mockResolvedValueOnce(answer(401, { code: 20003 }))
    const out = await checkIntegrationKey('twilio', CREDENTIAL)
    expect(out).toMatchObject({ ok: false, isVerificationError: true })
    expect((out as any).error).toMatch(/^Twilio rejected this key \(HTTP 401\)/)
  })

  it('refuse a key under "email", which nothing reads, and say which ids are read', async () => {
    const out = await checkIntegrationKey('email', `re_${crypto.randomBytes(12).toString('hex')}`)
    expect(out).toEqual({ ok: false, vaultId: 'email', error: EMAIL_IS_NOT_A_KEY, isFormatError: true })
    expect(EMAIL_IS_NOT_A_KEY).toContain('store the key as "resend" (re_…) or "sendgrid" (SG.…)')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('a Twilio value stored before the check', () => {
  it('is rejected when the vault asks again, with what it lacks, and Twilio is not asked', async () => {
    const out = await verifyIntegrationKey('twilio', `${SID}:${TOKEN}`)
    expect(out).toEqual({ status: 'rejected', detail: expect.stringMatching(/This value has 2 parts\.$/) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gives functions a twilio helper that says what to store, where they used to get a TypeError', async () => {
    mockStored.twilio = `${SID}:${TOKEN}`
    const ctx = await buildIntegrationContext('project-1')

    expect(ctx.isConnected('twilio')).toBe(true)
    await expect(ctx.twilio!.sendSms({ to: '+15550002222', body: 'hi' })).rejects.toThrow(
      /^Twilio cannot send: its stored credential is not accountSid:authToken:fromNumber\. .*This value has 2 parts\. Connect Twilio again with its accountSid, authToken and fromNumber\.$/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('a Twilio credential stored whole', () => {
  it('sends SMS from its number, authenticated as its account', async () => {
    mockStored.twilio = CREDENTIAL
    const ctx = await buildIntegrationContext('project-1')

    await expect(ctx.twilio!.sendSms({ to: '+15550002222', body: 'Your order shipped' })).resolves.toEqual({ sid: 'SM1', status: 'queued' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`)
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`)
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({ To: '+15550002222', From: FROM, Body: 'Your order shipped' })
  })
})
