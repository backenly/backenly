/**
 * How a probe result leaves a Fargate task.
 *
 * The only channel out of the task is its log stream, and a catalog snapshot
 * is far larger than one log event. The result is serialised, brotli-compressed,
 * base64-encoded and printed as numbered chunks between sentinels, followed by
 * a SHA-256 of the compressed bytes. Reassembly refuses a missing, duplicated
 * or reordered chunk, and a digest mismatch, rather than parsing whatever
 * happened to arrive.
 */

import { createHash } from 'node:crypto'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'

export const RESULT_BEGIN = '---LINEAGE-RESULT-BEGIN---'
export const RESULT_END = '---LINEAGE-RESULT-END---'

// Well under the 16 KB at which the container log driver starts splitting lines.
const CHUNK_CHARS = 8000

export function encodeResult(value: unknown): string[] {
  const packed = brotliCompressSync(Buffer.from(JSON.stringify(value), 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  })
  const b64 = packed.toString('base64')
  const total = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS))
  const lines = [RESULT_BEGIN]
  for (let i = 0; i < total; i++) {
    lines.push(`LINEAGE-CHUNK ${i + 1}/${total} ${b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)}`)
  }
  lines.push(`LINEAGE-SHA256 ${createHash('sha256').update(packed).digest('base64')}`)
  lines.push(RESULT_END)
  return lines
}

export function hasCompleteResult(lines: string[]): boolean {
  const begin = lines.findIndex(l => l.trim() === RESULT_BEGIN)
  return begin >= 0 && lines.slice(begin + 1).some(l => l.trim() === RESULT_END)
}

export function decodeResult<T = unknown>(lines: string[]): T {
  const begin = lines.findIndex(l => l.trim() === RESULT_BEGIN)
  if (begin < 0) throw new Error('no result block in the output')
  const endOffset = lines.slice(begin + 1).findIndex(l => l.trim() === RESULT_END)
  if (endOffset < 0) throw new Error('result block has no end marker; output is truncated')
  const block = lines.slice(begin + 1, begin + 1 + endOffset).map(l => l.trim())

  const chunks = new Map<number, string>()
  let total = -1
  let digest: string | null = null
  for (const line of block) {
    const chunk = line.match(/^LINEAGE-CHUNK (\d+)\/(\d+) ([A-Za-z0-9+/=]+)$/)
    if (chunk) {
      const [index, of] = [Number(chunk[1]), Number(chunk[2])]
      if (total === -1) total = of
      if (of !== total) throw new Error(`chunk ${index} claims ${of} chunks, earlier chunks claimed ${total}`)
      if (chunks.has(index)) throw new Error(`chunk ${index} appears twice`)
      chunks.set(index, chunk[3])
      continue
    }
    const sha = line.match(/^LINEAGE-SHA256 ([A-Za-z0-9+/=]+)$/)
    if (sha) {
      digest = sha[1]
      continue
    }
    throw new Error(`unexpected line inside result block: ${line.slice(0, 60)}`)
  }

  if (total < 1) throw new Error('result block holds no chunks')
  for (let i = 1; i <= total; i++) {
    if (!chunks.has(i)) throw new Error(`chunk ${i} of ${total} is missing`)
  }
  if (!digest) throw new Error('result block has no digest')

  const packed = Buffer.from(Array.from({ length: total }, (_, i) => chunks.get(i + 1)).join(''), 'base64')
  const actual = createHash('sha256').update(packed).digest('base64')
  if (actual !== digest) throw new Error('result digest does not match its chunks')

  return JSON.parse(brotliDecompressSync(packed).toString('utf8')) as T
}
