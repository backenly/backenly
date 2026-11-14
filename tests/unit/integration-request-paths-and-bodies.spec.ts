/**
 * ctx.integrations.<provider>.request() SENDS WHAT THE PROVIDER TAKES (#613)
 * ===========================================================================
 * request(method, path, body?, headers?) is the escape hatch on every
 * connected provider, and two things made it fail for common calls:
 *
 *   the version, twice   a relative path was appended to a base that already
 *                        ends in its version (Stripe, OpenAI, Anthropic,
 *                        Replicate, Runway and OneSignal in /v1, SendGrid in
 *                        /v3), and the method's own doc gave '/v1/x' as its
 *                        example, so openai.request('POST', '/v1/chat/completions')
 *                        went to /v1/v1/chat/completions and answered 404
 *   always JSON          every body was JSON.stringify'd and sent as
 *                        application/json. Stripe takes form-encoded bodies,
 *                        so every Stripe write outside the typed helpers
 *                        failed, and Stability's image endpoints take
 *                        multipart, so the registry's own Stability example
 *                        could not work
 *
 * The integration context is built here as functions get it, with the keys
 * the vault would return and the outbound request captured where it would
 * leave (safeFetch). safeFetch itself sends a byte body to a local server.
 * Through the real sandbox, vault and function rows:
 * tests/integration/integration-request-from-a-function.spec.ts.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

const mockKeys: Record<string, string> = {
  stripe: 'sk_test_request_paths',
  openai: 'sk-request-paths',
  stability: 'sk-stability-request-paths',
  onesignal: 'onesignal-rest-key',
  onesignal_app_id: 'app-1',
  replicate: 'r8_request_paths',
}

interface Sent {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string | Uint8Array
}
const mockSent: Sent[] = []

jest.mock('@/lib/services/integrationKeyStore', () => ({
  getIntegrationKey: jest.fn(async (_projectId: string, id: string) => mockKeys[id] ?? null),
}))
jest.mock('@/lib/security/outbound-guard', () => ({
  ...jest.requireActual('@/lib/security/outbound-guard'),
  safeFetch: jest.fn(async (url: string, opts: any = {}) => {
    mockSent.push({ url, method: opts.method, headers: opts.headers ?? {}, body: opts.body })
    const text = JSON.stringify({ ok: true })
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

import { buildIntegrationContext, resolveProviderUrl } from '@/lib/services/ai-functions/integration-context'
import { INTEGRATION_PROVIDERS, renderIntegrationDocs } from '@/lib/services/ai-functions/integration-registry'

const { safeFetch: realSafeFetch } = jest.requireActual('@/lib/security/outbound-guard')

/** A one-pixel PNG, as a function would hold it. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let ctx: Awaited<ReturnType<typeof buildIntegrationContext>>

beforeAll(async () => {
  ctx = await buildIntegrationContext('project-request-paths')
})
beforeEach(() => {
  mockSent.length = 0
})

const last = (): Sent => mockSent[mockSent.length - 1]
const contentType = (s: Sent) => s.headers['Content-Type']
const bodyText = (s: Sent) => (typeof s.body === 'string' ? s.body : Buffer.from(s.body!).toString('utf8'))

/** The fields of a form-encoded body, keys decoded. */
function formFields(s: Sent): Array<[string, string]> {
  return [...new URLSearchParams(bodyText(s)).entries()]
}

/** The parts of a multipart body, by the boundary its Content-Type names. */
function multipartParts(s: Sent): Array<{ name: string; filename?: string; contentType?: string; data: Buffer }> {
  const boundary = /boundary=(.+)$/.exec(contentType(s))![1]
  const raw = Buffer.from(s.body as Uint8Array).toString('latin1')
  expect(raw.endsWith(`--${boundary}--\r\n`)).toBe(true)
  return raw
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [head, ...rest] = part.slice(2).split('\r\n\r\n')
      const data = rest.join('\r\n\r\n').replace(/\r\n$/, '')
      const disposition = /Content-Disposition: form-data; name="([^"]*)"(?:; filename="([^"]*)")?/.exec(head)!
      const type = /Content-Type: (.+)/.exec(head)
      return {
        name: disposition[1],
        ...(disposition[2] !== undefined ? { filename: disposition[2] } : {}),
        ...(type ? { contentType: type[1] } : {}),
        data: Buffer.from(data, 'latin1'),
      }
    })
}

describe('a path is sent with its version once', () => {
  it.each([
    ['https://api.openai.com/v1', '/v1/chat/completions', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.openai.com/v1', 'v1/models', 'https://api.openai.com/v1/models'],
    ['https://api.openai.com/v1', '/v1?limit=5', 'https://api.openai.com/v1?limit=5'],
    ['https://api.sendgrid.com/v3', '/v3/mail/send', 'https://api.sendgrid.com/v3/mail/send'],
    ['https://onesignal.com/api/v1', '/api/v1/notifications', 'https://onesignal.com/api/v1/notifications'],
    ['https://api.stripe.com/v1', '/products', 'https://api.stripe.com/v1/products'],
    ['https://api.stability.ai', '/v2beta/stable-image/generate/core', 'https://api.stability.ai/v2beta/stable-image/generate/core'],
  ])('%s + %s → %s', (base, path, url) => {
    expect(resolveProviderUrl(base, path, 'demo')).toBe(url)
  })

  it('keeps a segment that only starts like the version', () => {
    expect(resolveProviderUrl('https://api.openai.com/v1', '/v10/x', 'openai')).toBe('https://api.openai.com/v1/v10/x')
    expect(resolveProviderUrl('https://api.openai.com/v1', '/v1x', 'openai')).toBe('https://api.openai.com/v1/v1x')
  })

  it('still keeps a path that repeats the version on the provider host', () => {
    const url = resolveProviderUrl('https://api.openai.com/v1', '/v1//evil.test/x', 'openai')
    expect(new URL(url).host).toBe('api.openai.com')
  })

  it("reaches every registry provider's endpoint whether or not its path repeats the base's own path", () => {
    for (const spec of Object.values(INTEGRATION_PROVIDERS)) {
      if (!spec.baseUrl) continue
      const basePath = new URL(spec.baseUrl).pathname.replace(/\/+$/, '')
      expect([spec.id, resolveProviderUrl(spec.baseUrl, `${basePath}/things`, spec.id)]).toEqual([spec.id, `${spec.baseUrl}/things`])
      expect([spec.id, resolveProviderUrl(spec.baseUrl, '/things', spec.id)]).toEqual([spec.id, `${spec.baseUrl}/things`])
    }
  })

  it('sends a call written as OpenAI documents it to the endpoint', async () => {
    await ctx.openai!.request!('POST', '/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
    expect(last().url).toBe('https://api.openai.com/v1/chat/completions')
    expect(contentType(last())).toBe('application/json')
    expect(JSON.parse(bodyText(last()))).toEqual({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
    expect(last().headers.Authorization).toBe(`Bearer ${mockKeys.openai}`)
  })
})

describe('a form-encoded body', () => {
  it('is what Stripe takes: a product, its metadata and its price, nested', async () => {
    await ctx.stripe!.request!('POST', '/v1/products', {
      name: 'Pro plan',
      metadata: { tier: 'pro' },
      default_price_data: { currency: 'usd', unit_amount: 1200, recurring: { interval: 'month' } },
      expand: ['default_price'],
    })
    expect(last().url).toBe('https://api.stripe.com/v1/products')
    expect(contentType(last())).toBe('application/x-www-form-urlencoded')
    expect(formFields(last())).toEqual([
      ['name', 'Pro plan'],
      ['metadata[tier]', 'pro'],
      ['default_price_data[currency]', 'usd'],
      ['default_price_data[unit_amount]', '1200'],
      ['default_price_data[recurring][interval]', 'month'],
      ['expand[0]', 'default_price'],
    ])
    expect(last().headers.Authorization).toBe(`Bearer ${mockKeys.stripe}`)
  })

  it("lists a Stripe subscription's items as items[0][price]", async () => {
    await ctx.stripe!.request!('POST', '/subscriptions', { customer: 'cus_1', items: [{ price: 'price_1', quantity: 2 }] })
    expect(last().url).toBe('https://api.stripe.com/v1/subscriptions')
    expect(formFields(last())).toEqual([
      ['customer', 'cus_1'],
      ['items[0][price]', 'price_1'],
      ['items[0][quantity]', '2'],
    ])
  })

  it('is not sent on a read', async () => {
    await ctx.stripe!.request!('GET', '/v1/products?limit=3', { ignored: true })
    expect(last()).toMatchObject({ url: 'https://api.stripe.com/v1/products?limit=3', method: 'GET', body: undefined })
  })

  it('gives way to JSON when a Stripe call asks for it', async () => {
    await ctx.stripe!.request!('POST', '/v1/products', { name: 'Pro plan' }, { 'content-type': 'application/json' })
    expect(contentType(last())).toBe('application/json')
    expect(JSON.parse(bodyText(last()))).toEqual({ name: 'Pro plan' })
    expect(Object.keys(last().headers).filter((h) => h.toLowerCase() === 'content-type')).toEqual(['Content-Type'])
  })

  it('leaves a string as it is', async () => {
    await ctx.stripe!.request!('POST', '/v1/products', 'name=Pro+plan')
    expect(contentType(last())).toBe('application/x-www-form-urlencoded')
    expect(last().body).toBe('name=Pro+plan')
  })

  it('is sent to any provider whose call names it', async () => {
    await ctx.replicate.request('POST', '/predictions', { input: { prompt: 'x' } }, { 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(contentType(last())).toBe('application/x-www-form-urlencoded')
    expect(formFields(last())).toEqual([['input[prompt]', 'x']])
  })

  it('refuses a list, by name', async () => {
    await expect(ctx.stripe!.request!('POST', '/v1/products', [{ name: 'x' }])).rejects.toThrow(
      'stripe.request(): a form body must be an object of fields.',
    )
  })
})

describe('a multipart body', () => {
  it("is what Stability takes, and the registry's own example now sends it", async () => {
    await ctx.stability.request('POST', '/v2beta/stable-image/generate/core', { prompt: 'a lighthouse at dusk', output_format: 'png' })
    expect(last().url).toBe('https://api.stability.ai/v2beta/stable-image/generate/core')
    expect(contentType(last())).toMatch(/^multipart\/form-data; boundary=BackenlyFormBoundary[0-9a-f]{32}$/)
    expect(last().headers.Accept).toBe('application/json')
    expect(last().headers.Authorization).toBe(`Bearer ${mockKeys.stability}`)
    expect(multipartParts(last()).map((p) => [p.name, p.data.toString('utf8')])).toEqual([
      ['prompt', 'a lighthouse at dusk'],
      ['output_format', 'png'],
    ])
  })

  it('carries a file from base64, byte for byte, with its name and type', async () => {
    await ctx.stability.request('POST', '/v2beta/stable-image/edit/erase', {
      image: { base64: PNG_BASE64, filename: 'photo.png', contentType: 'image/png' },
      output_format: 'webp',
    })
    const [image, format] = multipartParts(last())
    expect({ name: image.name, filename: image.filename, contentType: image.contentType }).toEqual({
      name: 'image',
      filename: 'photo.png',
      contentType: 'image/png',
    })
    expect(image.data.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true)
    expect([format.name, format.data.toString('utf8')]).toEqual(['output_format', 'webp'])
  })

  it('carries bytes, text and repeated fields, for any provider whose call names it', async () => {
    const audio = new Uint8Array([0, 1, 2, 250, 255, 13, 10])
    await ctx.openai!.request!(
      'POST',
      '/v1/audio/transcriptions',
      { file: { data: audio, filename: 'clip.mp3', contentType: 'audio/mpeg' }, model: 'whisper-1', temperature: 0, 'timestamp_granularities[]': ['word', 'segment'], notes: { data: 'plain text' } },
      { 'Content-Type': 'multipart/form-data' },
    )
    expect(last().url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(contentType(last())).toMatch(/^multipart\/form-data; boundary=/)
    const parts = multipartParts(last())
    expect(parts.map((p) => [p.name, p.filename ?? null, p.contentType ?? null])).toEqual([
      ['file', 'clip.mp3', 'audio/mpeg'],
      ['model', null, null],
      ['temperature', null, null],
      ['timestamp_granularities[]', null, null],
      ['timestamp_granularities[]', null, null],
      ['notes', 'file', 'application/octet-stream'],
    ])
    expect(parts[0].data.equals(Buffer.from(audio))).toBe(true)
    expect(parts.slice(1).map((p) => p.data.toString('utf8'))).toEqual(['whisper-1', '0', 'word', 'segment', 'plain text'])
  })

  it('escapes a quote or a line break in a name, so a field cannot write its own headers', async () => {
    await ctx.stability.request('POST', '/v2beta/stable-image/edit/erase', {
      'a"b': 'x',
      image: { data: 'y', filename: 'evil"\r\nX-Injected: 1.png' },
    })
    const raw = Buffer.from(last().body as Uint8Array).toString('latin1')
    expect(raw).toContain('name="a%22b"')
    expect(raw).toContain('filename="evil%22%0D%0AX-Injected: 1.png"')
    expect(raw).not.toMatch(/\r\nX-Injected/)
  })

  it('refuses a field that is neither a value nor a file, and a content type of more than one line', async () => {
    await expect(ctx.stability.request('POST', '/v2beta/stable-image/generate/core', { prompt: { nested: true } })).rejects.toThrow(
      'stability.request(): multipart field "prompt" must be a string, number, boolean, or a file',
    )
    await expect(
      ctx.stability.request('POST', '/v2beta/stable-image/edit/erase', { image: { base64: PNG_BASE64, contentType: 'image/png\r\nX: 1' } }),
    ).rejects.toThrow('stability.request(): the content type of file field "image" must be one line.')
    expect(mockSent).toEqual([])
  })

  it('sends JSON to Stability when the call asks for it', async () => {
    await ctx.stability.request('POST', '/v1/generation/x/text-to-image', { text_prompts: [{ text: 'hi' }] }, { 'Content-Type': 'application/json' })
    expect(contentType(last())).toBe('application/json')
    expect(JSON.parse(bodyText(last()))).toEqual({ text_prompts: [{ text: 'hi' }] })
  })
})

describe('what is unchanged', () => {
  it("still sends JSON by default, OneSignal's app_id merged in", async () => {
    await ctx.onesignal.request('POST', '/notifications', { contents: { en: 'Hi' } })
    expect(last().url).toBe('https://onesignal.com/api/v1/notifications')
    expect(contentType(last())).toBe('application/json')
    expect(JSON.parse(bodyText(last()))).toEqual({ app_id: 'app-1', contents: { en: 'Hi' } })
  })
})

describe('safeFetch', () => {
  let server: http.Server
  let received: { headers: http.IncomingHttpHeaders; body: Buffer } | null = null
  const original = process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE

  beforeAll(async () => {
    // This server is on loopback, which the guard refuses unless a self-hoster opens it.
    process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = 'true'
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        received = { headers: req.headers, body: Buffer.concat(chunks) }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })
  afterAll(async () => {
    if (original === undefined) delete process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
    else process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = original
    await new Promise((resolve) => server.close(resolve))
  })

  it('sends a byte body exactly, with its length in bytes', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const res = await realSafeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    })
    expect(res.status).toBe(200)
    expect(received!.headers['content-length']).toBe('256')
    expect(received!.body.equals(Buffer.from(bytes))).toBe(true)
  })
})

describe('what the function generator is told', () => {
  const docs = renderIntegrationDocs(['stripe', 'stability', 'openai', 'onesignal'])

  it('names the base each request() path is relative to, and no longer suggests /v1/x', () => {
    expect(docs).toContain('ctx.integrations.stripe (request() base: https://api.stripe.com/v1)')
    expect(docs).toContain('ctx.integrations.openai (request() base: https://api.openai.com/v1)')
    expect(docs).toContain('ctx.integrations.stability (request() base: https://api.stability.ai)')
    expect(docs).not.toContain("'/v1/x'")
  })

  it('says how Stripe and Stability bodies are sent, and how to send a file', () => {
    expect(docs).toContain('Stripe bodies are form-encoded')
    expect(docs).toContain('Bodies are sent as multipart/form-data')
    expect(docs).toContain('{ base64, filename?, contentType? }')
  })

  it('gives only examples that reach their endpoint once resolved', () => {
    for (const spec of Object.values(INTEGRATION_PROVIDERS)) {
      if (!spec.baseUrl) continue
      const basePath = new URL(spec.baseUrl).pathname.replace(/\/+$/, '')
      for (const m of spec.methods) {
        for (const [, path] of m.signature.matchAll(/request\('[A-Z]+',\s*['`]([^'`]+)['`]/g)) {
          const url = resolveProviderUrl(spec.baseUrl, path, spec.id)
          expect([spec.id, path, url.startsWith(`${spec.baseUrl}/`)]).toEqual([spec.id, path, true])
          if (basePath) expect([spec.id, path, new URL(url).pathname.startsWith(`${basePath}${basePath}/`)]).toEqual([spec.id, path, false])
        }
      }
    }
  })
})
