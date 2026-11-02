/**
 * EMBEDDINGS
 * ==========
 * What Backenly's vector search embeds with. The model is the deployment's
 * (EMBEDDING_PROVIDER, lib/ai/llm/embeddings.ts):
 *
 *   bedrock  amazon.titan-embed-text-v2:0, 1024 dimensions unless
 *            EMBEDDING_DIMENSIONS says 256 or 512; one input per request
 *   openai   text-embedding-3-small, 1536 dimensions
 *
 * Batched: pass an array of strings. They go to the provider 96 at a time, to
 * stay well under rate limits on smaller plans and to fail fast on a misuse
 * instead of timing out.
 *
 * Every input is trimmed to 8,000 characters whichever provider serves it.
 * That is under Titan's 50,000-character limit, and for ordinary text far
 * under both providers' token limits (8,191 for OpenAI, 8,192 for Titan), so a
 * long row is embedded by its beginning rather than refused. Text that
 * tokenizes unusually densely can still pass a token limit, and is then the
 * provider's invalid_request on either.
 */

import { embed, embeddingAvailability, embeddingConfig, type EmbeddingConfig } from './llm/embeddings'

export { embeddingAvailability, embeddingConfig }
export type { EmbeddingConfig }
const MAX_BATCH = 96
const MAX_INPUT_CHARS = 8000

/**
 * What a table whose vector search was enabled before the model and size were
 * recorded was made with: text-embedding-3-small at 1536, the only model
 * vector search used then.
 */
export const UNRECORDED_VECTOR_CONFIG = { model: 'text-embedding-3-small', dimensions: 1536 } as const

/**
 * Embed one or more strings. Returns `number[][]` aligned with input order.
 * Strings are trimmed to MAX_INPUT_CHARS — embeddings on long text are noisy
 * anyway, and this prevents accidental 100k-token inputs from blowing the
 * budget. Empty/whitespace-only inputs return an empty vector for that slot
 * (caller decides whether to skip the row).
 */
export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (!inputs || inputs.length === 0) return []

  const cleaned = inputs.map(t => (typeof t === 'string' ? t.trim().slice(0, MAX_INPUT_CHARS) : ''))
  const out: number[][] = new Array(cleaned.length)

  for (let i = 0; i < cleaned.length; i += MAX_BATCH) {
    const slice = cleaned.slice(i, i + MAX_BATCH)
    // Slot indices for the slice (in order) excluding empty strings
    const idxs: number[] = []
    const nonEmpty: string[] = []
    slice.forEach((t, j) => {
      if (t.length > 0) {
        idxs.push(i + j)
        nonEmpty.push(t)
      } else {
        out[i + j] = []
      }
    })
    if (nonEmpty.length === 0) continue

    const vectors = await embed(nonEmpty)
    vectors.forEach((vec, k) => {
      out[idxs[k]] = vec
    })
  }

  return out
}

/**
 * Why a table's stored vectors cannot be searched with the model configured
 * now (`configured`, the deployment's by default), or null when they can.
 *
 * A query vector from one model compared with row vectors from another returns
 * confident nonsense, not an error, and vectors of two sizes cannot be compared
 * at all, so the model and dimensions recorded when vector search was enabled
 * must match the configured ones before anything is embedded. A table enabled
 * before they were recorded is UNRECORDED_VECTOR_CONFIG. With no model
 * configured, nothing can be searched, and that is the reason given.
 */
export function vectorConfigMismatch(
  recorded: { model?: unknown; dimensions?: unknown },
  configured: EmbeddingConfig = embeddingConfig(),
): string | null {
  if ('reason' in configured) return configured.reason
  const model = typeof recorded.model === 'string' ? recorded.model : UNRECORDED_VECTOR_CONFIG.model
  const dimensions = typeof recorded.dimensions === 'number' ? recorded.dimensions : UNRECORDED_VECTOR_CONFIG.dimensions
  if (model === configured.model && dimensions === configured.dimensions) return null
  const made =
    `This table's vectors were made with ${model} (${dimensions} dimensions), and this deployment embeds ` +
    `with ${configured.model} (${configured.dimensions} dimensions). `
  return dimensions === configured.dimensions
    ? made +
        'Comparing the two would return meaningless matches, so the search was not run. ' +
        `The stored vectors need to be made again with ${configured.model}.`
    : made +
        'Vectors of different sizes cannot be compared, so the search was not run. ' +
        `The embedding column needs to hold ${configured.dimensions}-dimension vectors, made again with ${configured.model}.`
}

/** Embed a single string. Convenience wrapper. Returns [] on empty. */
export async function embedText(input: string): Promise<number[]> {
  const [vec] = await embedTexts([input])
  return vec ?? []
}

/**
 * Format an embedding as the literal string pgvector accepts as input:
 *   [0.1,0.2,...]
 * Used by SQL inserts where we cast `$N::vector`. Never JSON.stringify with
 * arbitrary spacing — pgvector's parser is strict on the literal format.
 */
export function formatVectorLiteral(vec: number[]): string {
  return '[' + vec.join(',') + ']'
}

/**
 * Build the input text for an auto-embedded row by concatenating the configured
 * source columns. Falls back to an empty string when every source value is
 * missing — caller should skip embedding in that case.
 */
export function buildEmbeddingSourceText(
  row: Record<string, unknown>,
  sourceColumns: string[],
): string {
  if (!Array.isArray(sourceColumns) || sourceColumns.length === 0) return ''
  return sourceColumns
    .map(c => row[c])
    .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
    .map(v => String(v).trim())
    .join('\n')
}
