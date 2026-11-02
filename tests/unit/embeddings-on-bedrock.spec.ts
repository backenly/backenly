/**
 * Vector-search embeddings with a provider of their own (lib/ai/llm/embeddings.ts):
 * which model and region the environment selects, what a Titan request on
 * Amazon Bedrock carries, how the SDK's retries and AWS failures end up as
 * AiErrors, and how a table's recorded model is checked against the configured
 * one.
 *
 * The Bedrock and OpenAI clients' send methods are stubbed, or, to run the AWS
 * SDK's own retry and (de)serialization, only its HTTP exchange is. The whole
 * file runs offline by construction (see OFFLINE below), so nothing here can
 * reach a network, AWS or a paid API, even with the code under test broken.
 * No database is involved.
 */

import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { HttpResponse } from '@smithy/core/protocols'
import { NodeHttp2Handler } from '@smithy/node-http-handler'
import {
  AccessDeniedException,
  BedrockRuntimeClient,
  InternalServerException,
  InvokeModelCommand,
  ModelErrorException,
  ModelNotReadyException,
  ModelTimeoutException,
  ResourceNotFoundException,
  ServiceQuotaExceededException,
  ServiceUnavailableException,
  ThrottlingException,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime'
import OpenAI from 'openai'
import { UNRECORDED_VECTOR_CONFIG, vectorConfigMismatch } from '@/lib/ai/embeddings'
import { resolveProvider } from '@/lib/ai/llm/config'
import { embed, embeddingAvailability, embeddingConfig } from '@/lib/ai/llm/embeddings'
import { AiError, classifyAwsError } from '@/lib/ai/llm/errors'

const TITAN = 'amazon.titan-embed-text-v2:0'
const BEDROCK = { EMBEDDING_PROVIDER: 'bedrock', BEDROCK_REGION: 'ap-south-1' }
const OPENAI_DEFAULT = { available: true, provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 }

// OFFLINE: every Bedrock client this file builds gets dummy credentials, no
// shared AWS config and a dead local endpoint, and the SDK's HTTP handler
// refuses unless a test answers it. A request that slips past a test's stub
// (a worker left running by a broken build, say) still cannot leave the machine.
const OFFLINE_ENV: Record<string, string | undefined> = {
  AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'not-a-real-secret',
  AWS_SESSION_TOKEN: undefined,
  AWS_PROFILE: undefined,
  AWS_BEARER_TOKEN_BEDROCK: undefined,
  AWS_CONFIG_FILE: path.join(os.tmpdir(), 'backenly-test-no-aws-config'),
  AWS_SHARED_CREDENTIALS_FILE: path.join(os.tmpdir(), 'backenly-test-no-aws-credentials'),
  AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'http://127.0.0.1:9',
}
const savedEnv: Record<string, string | undefined> = {}
const refuseHttp = async () => {
  throw new Error('embeddings-on-bedrock.spec.ts never sends an HTTP request')
}
let http: jest.SpyInstance

beforeAll(() => {
  for (const [k, v] of Object.entries(OFFLINE_ENV)) {
    savedEnv[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  http = jest.spyOn(NodeHttp2Handler.prototype, 'handle').mockImplementation(refuseHttp as never)
})
beforeEach(() => {
  http.mockReset()
  http.mockImplementation(refuseHttp as never)
})
afterAll(() => {
  http.mockRestore()
  for (const k of Object.keys(OFFLINE_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('which embedding model the environment selects', () => {
  it('keeps the old behaviour while EMBEDDING_PROVIDER is unset: OpenAI with a key, otherwise none', () => {
    expect(embeddingConfig({ OPENAI_API_KEY: 'k' })).toEqual(OPENAI_DEFAULT)
    expect(embeddingConfig({ EMBEDDING_PROVIDER: '  ', OPENAI_API_KEY: 'k' })).toEqual(OPENAI_DEFAULT)
    expect(embeddingConfig({})).toEqual({
      available: false,
      reason: expect.stringContaining('set EMBEDDING_PROVIDER=bedrock with EMBEDDING_REGION (or BEDROCK_REGION), or OPENAI_API_KEY'),
    })
  })

  it('never infers Bedrock, whatever serves chat', () => {
    // Every AWS host has a credential chain and a region.
    expect(embeddingConfig({ AI_PROVIDER: 'bedrock', BEDROCK_REGION: 'ap-south-1', AWS_REGION: 'ap-south-1' })).toMatchObject({
      available: false,
    })
    expect(embeddingConfig({ AI_PROVIDER: 'bedrock', BEDROCK_REGION: 'ap-south-1', OPENAI_API_KEY: 'k' })).toEqual(OPENAI_DEFAULT)
  })

  it('uses Titan Text Embeddings V2 at 1024 dimensions when Bedrock is chosen', () => {
    expect(embeddingConfig(BEDROCK)).toEqual({ available: true, provider: 'bedrock', model: TITAN, dimensions: 1024, region: 'ap-south-1' })
    // Chosen explicitly, Bedrock wins over an OpenAI key that is also set.
    expect(embeddingConfig({ ...BEDROCK, OPENAI_API_KEY: 'k' })).toMatchObject({ provider: 'bedrock' })
  })

  it('reads the provider in any case', () => {
    expect(embeddingConfig({ EMBEDDING_PROVIDER: ' Bedrock ', AWS_REGION: 'us-east-1' })).toMatchObject({ available: true, provider: 'bedrock' })
    expect(embeddingConfig({ EMBEDDING_PROVIDER: 'OPENAI', OPENAI_API_KEY: 'k' })).toEqual(OPENAI_DEFAULT)
  })

  it('embeds in EMBEDDING_REGION, then BEDROCK_REGION, then AWS_REGION', () => {
    const all = { EMBEDDING_PROVIDER: 'bedrock', EMBEDDING_REGION: 'eu-central-1', BEDROCK_REGION: 'ap-south-1', AWS_REGION: 'us-east-1' }
    expect(embeddingConfig(all)).toMatchObject({ available: true, region: 'eu-central-1' })
    expect(embeddingConfig({ ...all, EMBEDDING_REGION: ' ' })).toMatchObject({ region: 'ap-south-1' })
    expect(embeddingConfig({ ...all, EMBEDDING_REGION: undefined, BEDROCK_REGION: undefined })).toMatchObject({ region: 'us-east-1' })
    // EMBEDDING_REGION alone is enough.
    expect(embeddingConfig({ EMBEDDING_PROVIDER: 'bedrock', EMBEDDING_REGION: 'ap-southeast-1' })).toMatchObject({
      available: true,
      region: 'ap-southeast-1',
    })
  })

  it('keeps a regional stack’s text in its own region while chat stays on BEDROCK_REGION', () => {
    const regional = { AI_PROVIDER: 'bedrock', BEDROCK_REGION: 'ap-south-1', EMBEDDING_PROVIDER: 'bedrock', EMBEDDING_REGION: 'us-west-2', AWS_REGION: 'us-west-2' }
    expect(embeddingConfig(regional)).toMatchObject({ region: 'us-west-2' })
    expect(resolveProvider(regional)).toEqual({ ok: true, config: { id: 'bedrock', region: 'ap-south-1' } })
  })

  it('needs a region for Bedrock, and names every setting that gives one', () => {
    expect(embeddingConfig({ EMBEDDING_PROVIDER: 'bedrock', OPENAI_API_KEY: 'k' })).toEqual({
      available: false,
      reason: 'EMBEDDING_PROVIDER is bedrock, but none of EMBEDDING_REGION, BEDROCK_REGION or AWS_REGION is set.',
    })
  })

  it.each(['256', '512', '1024', ' 512 '])('accepts EMBEDDING_DIMENSIONS=%p on Bedrock', (d) => {
    expect(embeddingConfig({ ...BEDROCK, EMBEDDING_DIMENSIONS: d })).toMatchObject({ available: true, dimensions: Number(d) })
  })

  it.each(['1536', '768', '0', '-1024', '1024.0', '1e3', 'abc'])('refuses EMBEDDING_DIMENSIONS=%p on Bedrock', (d) => {
    expect(embeddingConfig({ ...BEDROCK, EMBEDDING_DIMENSIONS: d })).toEqual({
      available: false,
      reason: expect.stringMatching(/EMBEDDING_DIMENSIONS .*256, 512 or 1024/),
    })
  })

  it('takes a blank EMBEDDING_DIMENSIONS as unset', () => {
    expect(embeddingConfig({ ...BEDROCK, EMBEDDING_DIMENSIONS: '' })).toMatchObject({ dimensions: 1024 })
  })

  it('lets EMBEDDING_MODEL name another Bedrock model id', () => {
    const arn = 'arn:aws:bedrock:ap-south-1::foundation-model/amazon.titan-embed-text-v2:0'
    expect(embeddingConfig({ ...BEDROCK, EMBEDDING_MODEL: arn })).toMatchObject({ provider: 'bedrock', model: arn })
  })

  it('leaves OpenAI as it was: EMBEDDING_MODEL and EMBEDDING_DIMENSIONS are Bedrock settings', () => {
    expect(
      embeddingConfig({ EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'k', EMBEDDING_MODEL: 'x', EMBEDDING_DIMENSIONS: '512' }),
    ).toEqual(OPENAI_DEFAULT)
  })

  it('needs OPENAI_API_KEY once OpenAI is chosen, even on a Bedrock host', () => {
    expect(embeddingConfig({ EMBEDDING_PROVIDER: 'openai', BEDROCK_REGION: 'ap-south-1' })).toEqual({
      available: false,
      reason: 'EMBEDDING_PROVIDER is openai, but OPENAI_API_KEY is not set.',
    })
  })

  it('refuses a provider it does not know rather than falling back to another', () => {
    expect(embeddingConfig({ EMBEDDING_PROVIDER: 'cohere', OPENAI_API_KEY: 'k', BEDROCK_REGION: 'ap-south-1' })).toEqual({
      available: false,
      reason: 'EMBEDDING_PROVIDER "cohere" is not one of bedrock or openai.',
    })
  })

  it('answers availability alone, without the model', () => {
    expect(embeddingAvailability(BEDROCK)).toEqual({ available: true })
    expect(embeddingAvailability({ EMBEDDING_PROVIDER: 'bedrock' })).toEqual({
      available: false,
      reason: expect.stringMatching(/BEDROCK_REGION/),
    })
  })
})

describe('AWS failures as AiErrors', () => {
  const c = (err: unknown) => classifyAwsError(err, 'bedrock')
  const meta = (httpStatusCode: number, attempts?: number) => ({ $metadata: { httpStatusCode, attempts } })
  const named = (name: string, message: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), { name, ...extra })

  it.each([
    ['a throttle', new ThrottlingException({ message: 'Too many requests', ...meta(429) }), { kind: 'rate_limited', retryable: true, consumption: 'none' }],
    ['a refusal of the credentials', new AccessDeniedException({ message: 'not authorized', ...meta(403) }), { kind: 'access_denied', retryable: false, consumption: 'none' }],
    ['a model the account cannot reach', new ResourceNotFoundException({ message: 'no such model', ...meta(404) }), { kind: 'access_denied', consumption: 'none' }],
    ['an exhausted quota', new ServiceQuotaExceededException({ message: 'quota', ...meta(400) }), { kind: 'quota_exhausted', retryable: false, consumption: 'none' }],
    ['an invalid request', new ValidationException({ message: 'Malformed input request', ...meta(400) }), { kind: 'invalid_request', consumption: 'none' }],
    ['an overloaded service', new ServiceUnavailableException({ message: 'unavailable', ...meta(503) }), { kind: 'unavailable', retryable: true, consumption: 'none' }],
    ['a model still loading (a 429)', new ModelNotReadyException({ message: 'not ready', ...meta(429) }), { kind: 'unavailable', retryable: true, consumption: 'none' }],
    ['a model that ran long', new ModelTimeoutException({ message: 'timed out', ...meta(408) }), { kind: 'timeout', retryable: false, consumption: 'unknown' }],
    ['a model that failed while running', new ModelErrorException({ message: 'model error', ...meta(424) }), { kind: 'unavailable', retryable: false, consumption: 'unknown' }],
    ['a server error', new InternalServerException({ message: 'boom', ...meta(500) }), { kind: 'unavailable', retryable: false, consumption: 'unknown' }],
  ])('classifies %s by its name', (_label, err, expected) => {
    expect(c(err)).toMatchObject({ ...expected, provider: 'bedrock' })
  })

  it('falls back to the status for a failure it does not name', () => {
    expect(c(named('UnrecognizedClientException', 'bad token', meta(403)))).toMatchObject({ kind: 'access_denied', consumption: 'none' })
    expect(c(named('ExpiredTokenException', 'expired', meta(401)))).toMatchObject({ kind: 'access_denied' })
    expect(c(named('SlowDown', 'slow', meta(429)))).toMatchObject({ kind: 'rate_limited', retryable: true })
    expect(c(named('SomethingNewException', 'odd', meta(418)))).toMatchObject({ kind: 'invalid_request', consumption: 'none' })
    expect(c(named('SomethingNewException', 'busy', meta(503)))).toMatchObject({ kind: 'unavailable', consumption: 'none', retryable: true })
    expect(c(named('SomethingNewException', 'gateway', meta(502)))).toMatchObject({ kind: 'unavailable', consumption: 'unknown' })
  })

  it('calls a request that ran long a timeout, and a broken connection unavailable', () => {
    const silent = named('TimeoutError', 'Stream timed out because of no activity for 60000 ms')
    expect(c(silent)).toMatchObject({ kind: 'timeout', consumption: 'unknown' })
    const reset = named('TimeoutError', 'socket hang up', { code: 'ECONNRESET' })
    expect(c(reset)).toMatchObject({ kind: 'unavailable', consumption: 'unknown' })
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    expect(c(refused)).toMatchObject({ kind: 'unavailable', consumption: 'unknown' })
  })

  it('reads missing AWS credentials as not configured, with nothing sent', () => {
    const none = named('CredentialsProviderError', 'Could not load credentials from any providers')
    expect(c(none)).toMatchObject({ kind: 'not_configured', consumption: 'none', retryable: false })
  })

  it('keeps the provider’s words out of what a person is shown', () => {
    const role = 'arn:aws:sts::123456789012:assumed-role/web-task/abc'
    const e = c(new AccessDeniedException({ message: `User: ${role} is not authorized to perform: bedrock:InvokeModel`, ...meta(403) }))
    expect(e.userMessage).not.toContain('123456789012')
    expect(e.userMessage).toBe(new AiError('access_denied', 'detail', { consumption: 'none' }).userMessage)
    // The detail stays on the error, for the log.
    expect(e.message).toContain(role)
  })

  it('records how many requests the SDK sent before giving up', () => {
    expect(c(new ThrottlingException({ message: 'slow down', ...meta(429, 3) })).attempts).toBe(3)
  })

  it('passes an AiError through unchanged', () => {
    const e = new AiError('output_invalid', 'x', { provider: 'bedrock', consumption: 'ran' })
    expect(c(e)).toBe(e)
  })
})

describe('embedding on Bedrock', () => {
  let send: jest.SpyInstance | undefined
  afterEach(() => {
    send?.mockRestore()
    send = undefined
  })

  /** Titan's answer for `text-<i>`: i, then zeros, `dimensions` long. */
  const titanAnswer = (inputText: string, dimensions: number) => {
    const embedding = new Array<number>(dimensions).fill(0)
    embedding[0] = Number(inputText.split('-')[1])
    return { body: Buffer.from(JSON.stringify({ embedding, inputTextTokenCount: 3 })), $metadata: {} }
  }
  const stubSend = (impl: (this: BedrockRuntimeClient, command: InvokeModelCommand, options?: unknown) => Promise<unknown>) => {
    send = jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(impl as never)
    return send
  }
  const inputs = (n: number) => Array.from({ length: n }, (_, i) => `text-${i}`)

  it('sends one Titan request per input, with the configured dimensions and normalize: true', async () => {
    const seen: Array<{ body: unknown; modelId: unknown; contentType: unknown; options: unknown }> = []
    const clients: Array<{ region: string; maxAttempts: number }> = []
    stubSend(async function (command, options) {
      expect(command).toBeInstanceOf(InvokeModelCommand)
      const body = JSON.parse(String(command.input.body))
      seen.push({ body, modelId: command.input.modelId, contentType: command.input.contentType, options })
      clients.push({ region: await this.config.region(), maxAttempts: await this.config.maxAttempts() })
      return titanAnswer(body.inputText, body.dimensions)
    })

    const out = await embed(['text-0', 'text-1'], {
      ...BEDROCK,
      EMBEDDING_REGION: 'eu-central-1',
      AWS_REGION: 'us-east-1',
      EMBEDDING_DIMENSIONS: '512',
    })

    expect(seen).toEqual([
      { body: { inputText: 'text-0', dimensions: 512, normalize: true }, modelId: TITAN, contentType: 'application/json', options: { requestTimeout: 60_000 } },
      { body: { inputText: 'text-1', dimensions: 512, normalize: true }, modelId: TITAN, contentType: 'application/json', options: { requestTimeout: 60_000 } },
    ])
    // Sent where EMBEDDING_REGION says, by a client that tries four times.
    expect(clients).toEqual([
      { region: 'eu-central-1', maxAttempts: 4 },
      { region: 'eu-central-1', maxAttempts: 4 },
    ])
    expect(out.map((v) => v.length)).toEqual([512, 512])
  })

  it('runs at most four requests at once, and returns the vectors in input order', async () => {
    let inFlight = 0
    let most = 0
    stubSend(async (command) => {
      const body = JSON.parse(String(command.input.body))
      inFlight++
      most = Math.max(most, inFlight)
      // Later inputs answer sooner, so the answers arrive out of input order.
      const i = Number(body.inputText.split('-')[1])
      await new Promise((resolve) => setTimeout(resolve, 2 + ((25 - i) % 9)))
      inFlight--
      return titanAnswer(body.inputText, body.dimensions)
    })

    const out = await embed(inputs(25), BEDROCK)

    expect(send).toHaveBeenCalledTimes(25)
    expect(most).toBe(4)
    expect(out.map((v) => v[0])).toEqual(inputs(25).map((_, i) => i))
    expect(out.every((v) => v.length === 1024)).toBe(true)
  })

  it('starts nothing after a request fails, and throws that failure classified', async () => {
    stubSend(async (command) => {
      const body = JSON.parse(String(command.input.body))
      if (body.inputText === 'text-2') {
        throw new AccessDeniedException({
          message: 'User: arn:aws:sts::123456789012:assumed-role/web-task/abc is not authorized',
          $metadata: { httpStatusCode: 403 },
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return titanAnswer(body.inputText, body.dimensions)
    })

    const e = await embed(inputs(30), BEDROCK).catch((x) => x)
    // Let the requests already in flight finish: none of them may start another.
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(e).toBeInstanceOf(AiError)
    expect(e).toMatchObject({ kind: 'access_denied', provider: 'bedrock', consumption: 'none' })
    expect(e.userMessage).not.toContain('123456789012')
    // The four started together, and no more.
    expect(send!.mock.calls.length).toBe(4)
  })

  it('calls a request the SDK could not get past the throttle rate_limited, retryable and unbilled', async () => {
    stubSend(async () => {
      // What the SDK throws once its last attempt is throttled too.
      throw new ThrottlingException({
        message: 'Too many requests, please wait before trying again.',
        $metadata: { httpStatusCode: 429, attempts: 4, totalRetryDelay: 1500 },
      })
    })
    await expect(embed(['text-0'], BEDROCK)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      consumption: 'none',
      provider: 'bedrock',
      attempts: 4,
    })
  })

  it('refuses a vector of another size than the one configured', async () => {
    stubSend(async (command) => titanAnswer(JSON.parse(String(command.input.body)).inputText, 256))
    await expect(embed(['text-0'], BEDROCK)).rejects.toMatchObject({ kind: 'output_invalid', provider: 'bedrock', consumption: 'ran' })
  })

  it('refuses an answer that carries no embedding', async () => {
    stubSend(async () => ({ body: Buffer.from('{"message":"no vector here"}'), $metadata: {} }))
    await expect(embed(['text-0'], BEDROCK)).rejects.toMatchObject({ kind: 'output_invalid', provider: 'bedrock' })
  })

  it('sends nothing when Bedrock is chosen but not configured', async () => {
    stubSend(async () => {
      throw new Error('must not be sent')
    })
    await expect(embed(['text-0'], { EMBEDDING_PROVIDER: 'bedrock' })).rejects.toMatchObject({
      kind: 'not_configured',
      consumption: 'none',
      message: expect.stringMatching(/BEDROCK_REGION/),
    })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('through the AWS SDK itself, with only the HTTP exchange stubbed', () => {
  // A region no other test here uses: a client of its own, with a fresh retry quota.
  const ENV = { ...BEDROCK, EMBEDDING_REGION: 'us-west-2' }

  type Sent = { hostname: string; path: string; method: string; body: unknown; requestTimeout: unknown }
  const answer = (statusCode: number, body: unknown, headers: Record<string, string> = {}) => ({
    response: new HttpResponse({
      statusCode,
      headers: { 'content-type': 'application/json', ...headers },
      body: Readable.from([Buffer.from(JSON.stringify(body))]),
    }),
  })
  const throttled = () =>
    answer(429, { message: 'Too many requests, please wait before trying again.' }, { 'x-amzn-errortype': 'ThrottlingException' })
  const stubHttp = (impl: (sent: Sent) => ReturnType<typeof answer>) => {
    const sent: Sent[] = []
    http.mockImplementation((async (
      request: { hostname: string; path: string; method: string; body: unknown },
      options?: { requestTimeout?: number },
    ) => {
      const raw = typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array).toString('utf8')
      const one: Sent = {
        hostname: request.hostname,
        path: request.path,
        method: request.method,
        body: JSON.parse(raw),
        requestTimeout: options?.requestTimeout,
      }
      sent.push(one)
      return impl(one)
    }) as never)
    return sent
  }

  it('posts the JSON body to the model’s invoke path, with the timeout, and reads the vector back', async () => {
    const sent = stubHttp(() => answer(200, { embedding: new Array<number>(1024).fill(0.5), inputTextTokenCount: 2 }))

    const [vector] = await embed(['hello'], ENV)

    expect(vector).toHaveLength(1024)
    expect(sent).toEqual([
      {
        // The dead endpoint is in force, so a missing stub could not have gone out.
        hostname: '127.0.0.1',
        path: `/model/${encodeURIComponent(TITAN)}/invoke`,
        method: 'POST',
        body: { inputText: 'hello', dimensions: 1024, normalize: true },
        requestTimeout: 60_000,
      },
    ])
  })

  it('lets the SDK retry a throttle, backing off, and stops once one gets through', async () => {
    let n = 0
    const sent = stubHttp(() =>
      ++n < 3 ? throttled() : answer(200, { embedding: new Array<number>(1024).fill(0), inputTextTokenCount: 2 }),
    )

    const [vector] = await embed(['hello'], ENV)

    expect(sent).toHaveLength(3)
    expect(vector).toHaveLength(1024)
  }, 20_000)

  it('gives up after four attempts in all, and only then reports rate_limited', async () => {
    const sent = stubHttp(throttled)

    const e = await embed(['hello'], ENV).catch((x) => x)

    expect(sent).toHaveLength(4)
    expect(e).toBeInstanceOf(AiError)
    expect(e).toMatchObject({ kind: 'rate_limited', retryable: true, consumption: 'none', provider: 'bedrock', status: 429, attempts: 4 })
  }, 20_000)

  it('does not retry a refusal, and keeps the account out of what a person is shown', async () => {
    const sent = stubHttp(() =>
      answer(
        403,
        { message: 'User: arn:aws:sts::123456789012:assumed-role/web-task/abc is not authorized to perform: bedrock:InvokeModel' },
        { 'x-amzn-errortype': 'AccessDeniedException' },
      ),
    )

    const e = await embed(['hello'], ENV).catch((x) => x)

    expect(sent).toHaveLength(1)
    expect(e).toMatchObject({ kind: 'access_denied', consumption: 'none', status: 403 })
    expect(e.userMessage).not.toContain('123456789012')
  })
})

describe('embedding on OpenAI, as before', () => {
  it('sends every input in one text-embedding-3-small request', async () => {
    const create = jest.spyOn(OpenAI.Embeddings.prototype, 'create').mockImplementation((async (body: { input: string[] }) => ({
      data: body.input.map((_, i) => ({ index: i, object: 'embedding', embedding: new Array<number>(1536).fill(i) })),
    })) as never)
    try {
      const out = await embed(['a', 'b'], { OPENAI_API_KEY: 'k' })
      expect(create).toHaveBeenCalledTimes(1)
      expect(create.mock.calls[0][0]).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'] })
      expect(out.map((v) => [v.length, v[0]])).toEqual([
        [1536, 0],
        [1536, 1],
      ])
    } finally {
      create.mockRestore()
    }
  })
})

describe('a table’s stored vectors under a Bedrock deployment', () => {
  const titan1024 = embeddingConfig(BEDROCK)

  it('searches a table enabled with the configured model and size', () => {
    expect(vectorConfigMismatch({ model: TITAN, dimensions: 1024 }, titan1024)).toBeNull()
  })

  it('refuses a table enabled before the model was recorded, which used OpenAI at 1536', () => {
    expect(UNRECORDED_VECTOR_CONFIG).toEqual({ model: 'text-embedding-3-small', dimensions: 1536 })
    const why = vectorConfigMismatch({}, titan1024)
    expect(why).toContain('made with text-embedding-3-small (1536 dimensions)')
    expect(why).toContain(`embeds with ${TITAN} (1024 dimensions)`)
    expect(why).toContain('Vectors of different sizes cannot be compared')
    expect(why).toContain(`needs to hold 1024-dimension vectors, made again with ${TITAN}`)
  })

  it('refuses the same model at another size', () => {
    expect(vectorConfigMismatch({ model: TITAN, dimensions: 512 }, titan1024)).toContain('Vectors of different sizes cannot be compared')
  })

  it('refuses another model at the same size, whose matches would be meaningless', () => {
    const why = vectorConfigMismatch({ model: 'cohere.embed-english-v3', dimensions: 1024 }, titan1024)
    expect(why).toContain('meaningless matches')
    expect(why).toContain(`made again with ${TITAN}`)
  })

  it('refuses every table while no model is configured, and says why', () => {
    const none = embeddingConfig({ EMBEDDING_PROVIDER: 'bedrock' })
    expect(vectorConfigMismatch({ model: TITAN, dimensions: 1024 }, none)).toMatch(/BEDROCK_REGION/)
  })
})
