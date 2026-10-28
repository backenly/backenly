/**
 * A restore point that exists is not a restore point that can be trusted.
 *
 * When a change closes, its checkpoint, the state it left and its footprint are
 * hashed together, and each vault table it filled records its row count and an
 * order-independent checksum of its rows. Before anything is restored from
 * them, both are checked again. A mismatch means the record or the vault was
 * altered after the fact (by hand, by a bug, by a partial restore of a backup),
 * and the restore point is reported unusable rather than trusted: restoring
 * from a checkpoint that no longer describes the state it claims would put
 * production somewhere nobody recorded.
 */

import { createHash } from 'crypto'
import type { PoolClient } from 'pg'
import { qualified } from './names'

/** JSON with object keys sorted, so equal values hash equal however they were built or stored. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function checkpointHash(parts: { checkpoint: unknown; resultState: unknown; footprint: unknown }): string {
  return createHash('sha256')
    .update(canonicalJson({ checkpoint: parts.checkpoint, resultState: parts.resultState ?? null, footprint: parts.footprint ?? null }))
    .digest('hex')
}

/** True when the stored record still hashes to what was recorded when it closed. */
export function checkpointIntact(row: {
  checkpoint: unknown
  resultState: unknown
  footprint: unknown
  checkpointHash: string | null
}): boolean {
  if (!row.checkpointHash) return false
  return checkpointHash(row) === row.checkpointHash
}

/**
 * Row count and an order-independent checksum of a table's contents: the sum
 * of a 64-bit hash of each row's text. Any insert, update or delete changes it.
 */
export async function tableChecksum(
  client: Pick<PoolClient, 'query'>,
  schema: string,
  table: string,
): Promise<{ rows: number; checksum: string }> {
  const res = await client.query<{ n: string; h: string }>(
    `SELECT count(*)::bigint AS n, coalesce(sum(hashtextextended(t::text, 0)::numeric), 0)::text AS h FROM ${qualified(schema, table)} t`,
  )
  return { rows: Number(res.rows[0]?.n ?? 0), checksum: String(res.rows[0]?.h ?? '0') }
}
