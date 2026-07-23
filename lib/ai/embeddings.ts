/**
 * EMBEDDINGS
 * ==========
 * OpenAI text-embedding-3-small wrapper used by Backenly's vector search.
 *
 *   model:       text-embedding-3-small
 *   dimensions:  1536  (default, what pgvector(1536) columns expect)
 *   pricing:     ~$0.02 / 1M input tokens (Jan 2026)
 *
 * Batched: pass an array of strings; OpenAI accepts up to ~2048 inputs per
 * call. We cap at 96 per batch to stay well under TPM limits on smaller
 * plans and to fail fast on a misuse instead of timing out.
 */

import { getOpenAIClient } from './openai-service'

export const EMBEDDING_MODEL = 'text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536
const MAX_BATCH = 96
const MAX_INPUT_CHARS = 8000

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

    const openai = getOpenAIClient()
    const resp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: nonEmpty,
    })

    // OpenAI returns data[] in the same order as input[]
    resp.data.forEach((row, k) => {
      out[idxs[k]] = row.embedding
    })
  }

  return out
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
