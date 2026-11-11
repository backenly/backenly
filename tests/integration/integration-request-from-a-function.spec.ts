/**
 * A FUNCTION'S request() CALLS REACH THE PROVIDER AS IT TAKES THEM (#613)
 * =======================================================================
 * ctx.integrations.<provider>.request() doubled the base URL's version in a
 * path written as the provider documents it, and sent every body as JSON, so
 * OpenAI's '/v1/chat/completions' answered 404, every Stripe write outside the
 * typed helpers failed, and Stability's image endpoints, which take multipart,
 * could not be called at all.
 *
 * Here a function row runs in the real sandbox worker (executeAiFunction),
 * with the project's keys read from the real vault, and calls OpenAI, Stripe
 * and Stability the way their docs write the calls, sending an image to
 * Stability as base64 from the event. The request each call would send is
 * captured where it leaves the platform (safeFetch), which answers in its
 * place. Every encoding case: tests/unit/integration-request-paths-and-bodies.spec.ts.
 */

interface Sent {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string | Uint8Array
}
const mockSent: Sent[] = []

jest.mock('@/lib/security/outbound-guard', () => ({
  ...jest.requireActual('@/lib/security/outbound-guard'),
  safeFetch: jest.fn(async (url: string, opts: any = {}) => {
    mockSent.push({ url, method: opts.method, headers: opts.headers ?? {}, body: opts.body })
    const answer = url.includes('openai.com')
      ? { id: 'chatcmpl-1' }
      : url.includes('stripe.com')
        ? { id: 'prod_1', object: 'product' }
        : { image: 'aW1hZ2U=', finish_reason: 'SUCCESS' }
    const text = JSON.stringify(answer)
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }),
}))

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { encrypt } from '@/lib/services/encryption'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const KEYS = {
  openai: 'sk-function-request-test',
  stripe: 'sk_test_function_request',
  stability: 'sk-stability-function-request',
}
/** A one-pixel PNG, as the event carries it. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let userId = ''
let projectId = ''

beforeAll(async () => {
  assertSafeTestDatabase()
  userId = (await prisma.user.create({
    data: { email: `request-fn-${crypto.randomBytes(6).toString('hex')}@example.test`, name: 'request() from a function' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'request-from-a-function', userId }, select: { id: true } })).id
  for (const [integrationId, key] of Object.entries(KEYS)) {
    await prisma.projectIntegrationKey.create({
      data: { projectId, integrationId, encryptedKey: encrypt(key), maskedKey: `${key.slice(0, 4)}…`, verification: 'verified' },
    })
  }
}, 60_000)

afterAll(async () => {
  if (projectId) await prisma.projectIntegrationKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId } }).catch(() => {})
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

/** The parts of a multipart body, by the boundary its Content-Type names. */
function multipartParts(s: Sent): Array<{ head: string; data: Buffer }> {
  const boundary = /boundary=(.+)$/.exec(s.headers['Content-Type'])![1]
  return Buffer.from(s.body as Uint8Array)
    .toString('latin1')
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [head, ...rest] = part.slice(2).split('\r\n\r\n')
      return { head, data: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n$/, ''), 'latin1') }
    })
}

it('sends OpenAI, Stripe and Stability calls, written as their docs write them, as each provider takes them', async () => {
  const fn = await prisma.aiFunction.create({
    data: {
      projectId,
      name: 'calls-three-providers',
      description: 'request() to OpenAI, Stripe and Stability',
      triggerType: 'manual',
      status: 'active',
      generatedCode: `
        const chat = await ctx.integrations.openai.request('POST', '/v1/chat/completions', {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
        })
        const product = await ctx.integrations.stripe.request('POST', '/v1/products', {
          name: 'Pro plan',
          metadata: { tier: 'pro' },
        })
        const erased = await ctx.integrations.stability.request('POST', '/v2beta/stable-image/edit/erase', {
          image: { base64: event.data.png, filename: 'photo.png', contentType: 'image/png' },
          output_format: 'webp',
        })
        return { chat, product, erased }
      `,
    },
  })

  const result = await executeAiFunction(fn.id, projectId, { type: 'manual', data: { png: PNG_BASE64 } }, { selfHeal: false })

  expect({ success: result.success, error: result.error }).toEqual({ success: true, error: undefined })
  expect(result.returnValue).toEqual({
    chat: { id: 'chatcmpl-1' },
    product: { id: 'prod_1', object: 'product' },
    erased: { image: 'aW1hZ2U=', finish_reason: 'SUCCESS' },
  })
  expect(mockSent.map((s) => [s.method, s.url])).toEqual([
    ['POST', 'https://api.openai.com/v1/chat/completions'],
    ['POST', 'https://api.stripe.com/v1/products'],
    ['POST', 'https://api.stability.ai/v2beta/stable-image/edit/erase'],
  ])
  const [openai, stripe, stability] = mockSent

  // Each with the project's own key, from the vault.
  expect(openai.headers.Authorization).toBe(`Bearer ${KEYS.openai}`)
  expect(stripe.headers.Authorization).toBe(`Bearer ${KEYS.stripe}`)
  expect(stability.headers.Authorization).toBe(`Bearer ${KEYS.stability}`)

  expect(openai.headers['Content-Type']).toBe('application/json')
  expect(JSON.parse(String(openai.body))).toEqual({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })

  expect(stripe.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
  expect([...new URLSearchParams(String(stripe.body)).entries()]).toEqual([
    ['name', 'Pro plan'],
    ['metadata[tier]', 'pro'],
  ])

  expect(stability.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/)
  expect(stability.headers.Accept).toBe('application/json')
  const [image, format] = multipartParts(stability)
  expect(image.head).toBe('Content-Disposition: form-data; name="image"; filename="photo.png"\r\nContent-Type: image/png')
  expect(image.data.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true)
  expect([format.head, format.data.toString('utf8')]).toEqual(['Content-Disposition: form-data; name="output_format"', 'webp'])
}, 60_000)
