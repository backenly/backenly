/**
 * THE CONTACT PAGE'S MESSAGE FORM (app/api/contact)
 * =================================================
 * The route runs for real: its validation, the hourly limiter, the bot
 * check's answer when Turnstile is not configured, and delivery to a real
 * SMTP server after a real STARTTLS handshake (tests/helpers/smtp-sink).
 * Only the request envelope is constructed, as in the auth route suites.
 *
 * What it pins: a message reaches one fixed inbox, with the sender as
 * Reply-To, and never an address the sender typed; the sender is told the
 * truth when it was not sent; a bot that fills the hidden field is answered
 * quietly and nothing is sent; and off Backenly Cloud the route is not there.
 */
import type { NextRequest } from 'next/server'
import { SmtpSink, trustCertificate } from '../../tests/helpers/smtp-sink'
import { POST as contact } from '@/app/api/contact/route'

const ENV_KEYS = [
  'BACKENLY_EDITION',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'CONTACT_INBOX',
  'TURNSTILE_SECRET_KEY',
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = {}

let sink: SmtpSink
let untrust: (() => void) | null = null
let ipCounter = 0

function request(body: unknown, network?: string): NextRequest {
  ipCounter += 1
  const headers = new Map<string, string>([
    ['content-type', 'application/json'],
    ['x-forwarded-for', network ?? `203.0.113.${ipCounter % 250}`],
  ])
  return {
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    cookies: { get: () => undefined },
    json: async () => body,
  } as unknown as NextRequest
}

async function send(body: unknown, network?: string) {
  const res = await contact(request(body, network))
  return { status: res.status, body: await res.json() }
}

function message(over: Record<string, unknown> = {}) {
  return {
    name: 'Ada',
    email: `ada-${Math.random().toString(36).slice(2, 10)}@example.test`,
    company: 'Example Labs',
    topic: 'Sales or Enterprise',
    message: 'We would like to talk about an Enterprise plan for our team.',
    ...over,
  }
}

function useMail(): void {
  process.env.SMTP_HOST = '127.0.0.1'
  process.env.SMTP_PORT = String(sink.port)
  process.env.SMTP_USER = 'sink-user'
  process.env.SMTP_PASS = 'sink-password-not-real'
  process.env.SMTP_FROM = 'Backenly <noreply@example.test>'
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k]
  sink = new SmtpSink()
  await sink.start()
  untrust = trustCertificate(sink.certificate)
}, 120_000)

beforeEach(() => {
  process.env.BACKENLY_EDITION = 'cloud'
  delete process.env.TURNSTILE_SECRET_KEY
  delete process.env.CONTACT_INBOX
  sink.rejectWith = null
  sink.received.length = 0
  useMail()
})

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL_ENV[k]
  }
  untrust?.()
  await sink?.stop().catch(() => {})
})

describe('POST /api/contact', () => {
  it('delivers to the team inbox, with the sender as Reply-To', async () => {
    const m = message()
    const res = await send(m)
    expect(res).toEqual({ status: 200, body: { ok: true } })
    expect(sink.received).toHaveLength(1)
    const [mail] = sink.received
    expect(mail.rcptTo.map((r) => r.toLowerCase())).toEqual(['support@backenly.com'])
    expect(mail.raw).toMatch(new RegExp(`^Reply-To: ${m.email}`, 'mi'))
    expect(mail.raw).toMatch(/^Subject: Contact: Sales or Enterprise from Ada/m)
    expect(mail.raw).toContain(m.message)
  })

  it('never mails an address the sender typed, whatever is in the fields', async () => {
    const res = await send(
      message({ email: 'someone-else@example.test', name: 'Ada\r\nBcc: third@example.test', company: 'x\r\nCc: fourth@example.test' }),
    )
    expect(res.status).toBe(200)
    expect(sink.received).toHaveLength(1)
    expect(sink.received[0].rcptTo.map((r) => r.toLowerCase())).toEqual(['support@backenly.com'])
    const headers = sink.received[0].raw.split(/\r?\n\r?\n/)[0]
    expect(headers).not.toMatch(/^(Bcc|Cc):/im)
    // One-line fields stay one line, in the body too.
    expect(sink.received[0].raw).not.toMatch(/^(Bcc|Cc): /m)
  })

  it('sends to CONTACT_INBOX when it is set', async () => {
    process.env.CONTACT_INBOX = 'team@example.test'
    expect((await send(message())).status).toBe(200)
    expect(sink.received[0].rcptTo.map((r) => r.toLowerCase())).toEqual(['team@example.test'])
  })

  it('answers a bot that fills the hidden field as if it worked, and sends nothing', async () => {
    const res = await send(message({ website: 'https://spam.example' }))
    expect(res).toEqual({ status: 200, body: { ok: true } })
    expect(sink.received).toHaveLength(0)
  })

  it('returns each invalid field by name', async () => {
    const res = await send({ email: 'not-an-address', topic: 'General question', message: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_INPUT')
    expect(Object.keys(res.body.fields).sort()).toEqual(['email', 'message'])
    expect(sink.received).toHaveLength(0)
  })

  it('refuses an address the mailer would not take, as a field error', async () => {
    const res = await send(message({ email: '"quoted"@example.test' }))
    expect(res.status).toBe(400)
    expect(res.body.fields.email).toBeDefined()
    expect(sink.received).toHaveLength(0)
  })

  it('refuses a topic the form does not offer', async () => {
    const res = await send(message({ topic: 'Anything' }))
    expect(res.status).toBe(400)
    expect(res.body.fields.topic).toBeDefined()
  })

  it('says it was not sent when mail is not configured', async () => {
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[k]
    const res = await send(message())
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE')
    expect(res.body.error).toContain('support@backenly.com')
  })

  it('says it was not sent when the provider refuses the message', async () => {
    sink.rejectWith = '550 The example.test domain is not verified.'
    const res = await send(message())
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE')
  })

  it('takes five messages an hour from one network', async () => {
    const network = '192.0.2.77'
    for (let i = 0; i < 5; i += 1) expect((await send(message(), network)).status).toBe(200)
    const sixth = await send(message(), network)
    expect(sixth.status).toBe(429)
    expect(sixth.body.code).toBe('RATE_LIMITED')
  })

  it('takes three messages an hour from one address', async () => {
    const m = message()
    for (let i = 0; i < 3; i += 1) expect((await send(m)).status).toBe(200)
    expect((await send(m)).status).toBe(429)
  })

  it('is not there outside Backenly Cloud', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    const res = await send(message())
    expect(res.status).toBe(404)
    expect(sink.received).toHaveLength(0)
  })
})
