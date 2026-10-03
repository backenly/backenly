/**
 * The SQL a replay task carries, as it travels through a task definition.
 */

import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'

export interface ReplayInput {
  purpose: 'chain' | 'push'
  source: Record<string, unknown>
  files: Array<{ name: string; sql: string }>
}

export function encodeInput(input: ReplayInput): string {
  return brotliCompressSync(Buffer.from(JSON.stringify(input), 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString('base64')
}

export function decodeInput(b64: string | undefined): ReplayInput {
  if (!b64) throw new Error('replay mode needs LINEAGE_INPUT_B64')
  let parsed: unknown
  try {
    parsed = JSON.parse(brotliDecompressSync(Buffer.from(b64, 'base64')).toString('utf8'))
  } catch {
    throw new Error('replay input could not be decoded')
  }
  const input = parsed as ReplayInput
  if (input?.purpose !== 'chain' && input?.purpose !== 'push') throw new Error('replay input has no valid purpose')
  if (!Array.isArray(input.files) || input.files.length === 0) throw new Error('replay input has no files')
  for (const f of input.files) {
    if (typeof f?.name !== 'string' || typeof f?.sql !== 'string' || f.sql.length === 0) {
      throw new Error('replay input holds a malformed file')
    }
  }
  return input
}
