/**
 * Embeddings, the gateway's one call that is not a chat.
 *
 * No Claude model makes embeddings, so vector search names its own provider,
 * apart from AI_PROVIDER:
 *
 *   EMBEDDING_PROVIDER=bedrock  Amazon Titan Text Embeddings V2 on Amazon
 *                               Bedrock, with the AWS provider chain's
 *                               credentials (on ECS, the task role; no key is
 *                               stored), in EMBEDDING_REGION, then
 *                               BEDROCK_REGION, then AWS_REGION. EMBEDDING_MODEL
 *                               replaces the model id; EMBEDDING_DIMENSIONS is
 *                               256, 512 or 1024 (default 1024).
 *   EMBEDDING_PROVIDER=openai   OpenAI text-embedding-3-small, 1536 dimensions.
 *                               Needs OPENAI_API_KEY.
 *   unset                       OpenAI when OPENAI_API_KEY is set, otherwise
 *                               none. Bedrock is never inferred, as for chat
 *                               (lib/ai/llm/config.ts): an AWS credential chain
 *                               exists on any AWS host.
 *
 * The region is where a project's text is sent to be embedded, so a regional
 * stack sets EMBEDDING_REGION to its own region: BEDROCK_REGION, which chat
 * uses too, may name another, and it comes before AWS_REGION.
 *
 * Titan takes one input per request, and its on-demand quota is counted in
 * requests a minute and can be small. So few requests run at once, and the
 * SDK's own retry, backing off, absorbs a burst over the quota before a call
 * that is still throttled becomes rate_limited. A failed call logs the
 * gateway's marker line once, after those retries (lib/ai/llm/alerts.ts), so a
 * throttled or refused embedding model is as visible to an alarm as chat.
 *
 * Vectors compare only with vectors from the same model at the same size, so
 * vector search records `embeddingConfig()` when it is enabled on a table and
 * refuses to search once the configuration has moved (vectorConfigMismatch in
 * lib/ai/embeddings.ts). Without a model it reports itself unavailable instead
 * of failing deeper in.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import OpenAI from 'openai'
import { reportAiFailure } from './alerts'
import { AiError, classifyAwsError, classifyProviderError } from './errors'

type Env = Record<string, string | undefined>

const TITAN_MODEL = 'amazon.titan-embed-text-v2:0'
/** The sizes Titan Text Embeddings V2 can return. */
const TITAN_DIMENSIONS: readonly number[] = [256, 512, 1024]
const TITAN_DEFAULT_DIMENSIONS = 1024
const OPENAI_MODEL = 'text-embedding-3-small'
const OPENAI_DIMENSIONS = 1536

const TIMEOUT_MS = 60_000
/** Titan embeds one input per request; at most this many run at once. */
const BEDROCK_CONCURRENCY = 4
/** Requests the SDK sends for one input before it gives up, throttled or failing. */
const BEDROCK_MAX_ATTEMPTS = 4

/** The model this deployment embeds with, the size of its vectors and, on Bedrock, the region; or why there is none. */
export type EmbeddingConfig =
  | { available: true; provider: 'bedrock'; model: string; dimensions: number; region: string }
  | { available: true; provider: 'openai'; model: string; dimensions: number }
  | { available: false; reason: string }

interface BedrockSetup { provider: 'bedrock'; model: string; dimensions: number; region: string }
interface OpenAISetup { provider: 'openai'; model: string; dimensions: number; apiKey: string }

const set = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined)

function resolve(env: Env): { setup: BedrockSetup | OpenAISetup } | { reason: string } {
  const chosen = set(env.EMBEDDING_PROVIDER)?.toLowerCase()

  if (chosen === 'bedrock') {
    const region = set(env.EMBEDDING_REGION) ?? set(env.BEDROCK_REGION) ?? set(env.AWS_REGION)
    if (!region) {
      return { reason: 'EMBEDDING_PROVIDER is bedrock, but none of EMBEDDING_REGION, BEDROCK_REGION or AWS_REGION is set.' }
    }
    const raw = set(env.EMBEDDING_DIMENSIONS)
    const dimensions = raw === undefined ? TITAN_DEFAULT_DIMENSIONS : /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!TITAN_DIMENSIONS.includes(dimensions)) {
      return { reason: `EMBEDDING_DIMENSIONS is "${raw}", and Titan Text Embeddings V2 makes vectors of 256, 512 or 1024 dimensions.` }
    }
    return { setup: { provider: 'bedrock', model: set(env.EMBEDDING_MODEL) ?? TITAN_MODEL, dimensions, region } }
  }
  if (chosen !== undefined && chosen !== 'openai') {
    return { reason: `EMBEDDING_PROVIDER "${chosen}" is not one of bedrock or openai.` }
  }
  // OpenAI, chosen or by default: text-embedding-3-small at its full size, as it
  // has always been. EMBEDDING_MODEL and EMBEDDING_DIMENSIONS are Bedrock's.
  const apiKey = set(env.OPENAI_API_KEY)
  if (apiKey) return { setup: { provider: 'openai', model: OPENAI_MODEL, dimensions: OPENAI_DIMENSIONS, apiKey } }
  return {
    reason: chosen
      ? 'EMBEDDING_PROVIDER is openai, but OPENAI_API_KEY is not set.'
      : 'Vector search needs an embedding model, and none is configured: set EMBEDDING_PROVIDER=bedrock with ' +
        'EMBEDDING_REGION (or BEDROCK_REGION), or OPENAI_API_KEY.',
  }
}

/**
 * The embedding model and vector size this deployment uses, or why it has
 * none. Configuration only: a configured provider can still fail.
 */
export function embeddingConfig(env: Env = process.env): EmbeddingConfig {
  const r = resolve(env)
  if ('reason' in r) return { available: false, reason: r.reason }
  const s = r.setup
  return 'region' in s
    ? { available: true, provider: 'bedrock', model: s.model, dimensions: s.dimensions, region: s.region }
    : { available: true, provider: 'openai', model: s.model, dimensions: s.dimensions }
}

/** Whether embeddings can be made here, and if not, why. Configuration only. */
export function embeddingAvailability(env: Env = process.env): { available: true } | { available: false; reason: string } {
  const c = embeddingConfig(env)
  return 'reason' in c ? { available: false, reason: c.reason } : { available: true }
}

/**
 * One vector per input, in input order, each `embeddingConfig().dimensions`
 * long. Inputs must be non-empty. lib/ai/embeddings.ts trims each to 8,000
 * characters whichever provider serves it; an input past a provider's own
 * limit is that provider's invalid_request, on either.
 */
export async function embed(inputs: string[], env: Env = process.env): Promise<number[][]> {
  const r = resolve(env)
  const setup = 'setup' in r ? r.setup : undefined
  try {
    if ('reason' in r) throw new AiError('not_configured', r.reason, { consumption: 'none' })
    if (inputs.length === 0) return []
    return await embedWith(r.setup, inputs)
  } catch (err) {
    // Every way a call ends in failure passes here once, after the SDK's
    // retries: no model, the provider's refusal, or an answer of the wrong
    // shape. Several of a call's requests failing still make one call.
    if (err instanceof AiError) reportAiFailure(err, { purpose: 'embeddings', provider: setup?.provider, model: setup?.model })
    throw err
  }
}

async function embedWith(setup: BedrockSetup | OpenAISetup, inputs: string[]): Promise<number[][]> {
  const vectors = setup.provider === 'bedrock' ? await embedOnBedrock(setup, inputs) : await embedOnOpenAI(setup, inputs)

  // A vector of another size can neither be stored in the table's column nor
  // compared with it: a configuration fault, said here rather than by pgvector.
  if (vectors.length !== inputs.length || vectors.some((v) => v.length !== setup.dimensions)) {
    throw new AiError(
      'output_invalid',
      `Expected ${inputs.length} vector(s) of ${setup.dimensions} from ${setup.model}; ` +
        `got ${vectors.length}, the first ${vectors[0]?.length ?? 0} long.`,
      { provider: setup.provider, consumption: 'ran' },
    )
  }
  return vectors
}

// ── Amazon Bedrock: Titan Text Embeddings V2 ────────────────────────────────

let bedrock: { region: string; client: BedrockRuntimeClient } | null = null

function bedrockFor(region: string): BedrockRuntimeClient {
  if (bedrock?.region !== region) {
    bedrock = {
      region,
      // The SDK's standard retry absorbs a burst over the quota: a throttled or
      // transiently failed request is sent again after a growing, jittered
      // pause, and only one still refused after the last attempt reaches
      // classifyAwsError, as rate_limited. Like the OpenAI client's retries,
      // it repeats server errors too: an embedding is idempotent and costs a
      // fraction of a cent, so that is not the double charge a retried chat
      // call can be. The HTTP handler stays the SDK's own (HTTP/2, one session
      // per request).
      client: new BedrockRuntimeClient({ region, maxAttempts: BEDROCK_MAX_ATTEMPTS }),
    }
  }
  return bedrock.client
}

async function embedOnBedrock(setup: BedrockSetup, inputs: string[]): Promise<number[][]> {
  const client = bedrockFor(setup.region)
  return mapInOrder(inputs, BEDROCK_CONCURRENCY, async (inputText) => {
    let body: Uint8Array | undefined
    try {
      const resp = await client.send(
        new InvokeModelCommand({
          modelId: setup.model,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({ inputText, dimensions: setup.dimensions, normalize: true }),
        }),
        // Per attempt: a stream silent this long fails as a TimeoutError.
        { requestTimeout: TIMEOUT_MS },
      )
      body = resp.body
    } catch (err) {
      throw classifyAwsError(err, 'bedrock')
    }
    return titanVector(body)
  })
}

/** Titan answers `{ embedding, inputTextTokenCount }`. */
function titanVector(body: Uint8Array | undefined): number[] {
  let embedding: unknown
  try {
    embedding = JSON.parse(Buffer.from(body ?? new Uint8Array()).toString('utf8')).embedding
  } catch {
    embedding = undefined
  }
  if (!Array.isArray(embedding) || !embedding.every((n) => typeof n === 'number')) {
    throw new AiError('output_invalid', 'Bedrock answered without an embedding.', { provider: 'bedrock', consumption: 'ran' })
  }
  return embedding
}

/**
 * `fn` over every item, at most `limit` at once, with the results in item
 * order. After the first failure no further item is started, and that failure
 * is what rejects.
 */
async function mapInOrder<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i])
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ── OpenAI: text-embedding-3-small ──────────────────────────────────────────

let openai: { key: string; client: OpenAI } | null = null

function openaiFor(key: string): OpenAI {
  if (openai?.key !== key) openai = { key, client: new OpenAI({ apiKey: key, maxRetries: 2 }) }
  return openai.client
}

async function embedOnOpenAI(setup: OpenAISetup, inputs: string[]): Promise<number[][]> {
  try {
    const resp = await openaiFor(setup.apiKey).embeddings.create({ model: setup.model, input: inputs }, { timeout: TIMEOUT_MS })
    // Returned in input order.
    return resp.data.map((row) => row.embedding)
  } catch (err) {
    throw classifyProviderError(err, 'openai')
  }
}
