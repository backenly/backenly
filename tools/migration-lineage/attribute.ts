/**
 * Attribution: which known, named cause explains a difference.
 *
 * The rule the gate rests on is that a manifest entry attributes an object only
 * when the object's DEFINITION matches what the entry says that source produces.
 * A name match is not attribution: `add_rls_policies.sql` names tables that were
 * renamed years ago, and a staging object could carry the same name for an
 * unrelated reason. So every entry must declare expectations, and an entry whose
 * name matches while its expectations do not is reported as unexplained with
 * that fact stated, never quietly absorbed.
 */

import type { Difference, Row } from './diff'

export type Bucket =
  | 'represented_in_schema_prisma'
  | 'known_legacy_sql_effect'
  | 'known_provisioning_effect'
  | 'expected_environmental_difference'
  | 'unexplained_divergence'

export const MANIFEST_BUCKETS: Bucket[] = [
  'known_legacy_sql_effect',
  'known_provisioning_effect',
  'expected_environmental_difference',
]

/** How an entry's expectations were established. */
export type Derivation =
  /** Observed by replaying the source into a throwaway database and capturing it. */
  | 'replayed'
  /** Read from the source by a person, because it could not be replayed. */
  | 'reviewed'

export type ReplayStatus =
  | 'valid_postgres'
  | 'invalid_postgres'
  | 'depends_on_db_push'
  | 'partial_historical_effect_possible'
  | 'unknown'

export interface ManifestEntry {
  /** Exactly the key diff.ts produces: "<kind> <identity>". */
  key: string
  /**
   * Field values this source is expected to produce. Never empty.
   *
   * Only what should GATE equality belongs here. A property worth recording but
   * not worth failing on — an extension version, say — goes in `observed`.
   */
  expect: Record<string, unknown>
  /** A narrower class within the bucket, for entries that need one. */
  subtype?: 'platform_extension' | 'migration_ledger'
  /** Who is responsible for creating it. */
  ownership?: string
  /** Whether the platform depends on it, as opposed to tolerating it. */
  required?: boolean
  /** Repository paths that establish the provenance claim. */
  evidence?: string[]
  /** A server-level condition the object alone does not prove. */
  serverPrerequisite?: string
  /** What a real check of this object would have to establish. */
  validation?: string
  /** Recorded at capture time, deliberately NOT gating. */
  observed?: Record<string, unknown>
  note?: string
}

export interface Manifest {
  id: string
  bucket: Bucket
  /** The file or mechanism this manifest describes. */
  source: string
  derivation: Derivation
  replayStatus?: ReplayStatus
  confidence: 'observed' | 'derived' | 'asserted'
  notes?: string
  entries: ManifestEntry[]
}

export function validateManifest(m: Manifest): void {
  if (!MANIFEST_BUCKETS.includes(m.bucket)) throw new Error(`${m.id}: bucket ${m.bucket} cannot be claimed by a manifest`)
  if (!m.source) throw new Error(`${m.id}: manifest has no source`)
  const seen = new Set<string>()
  for (const e of m.entries) {
    if (!e.key.includes(' ')) throw new Error(`${m.id}: entry key ${JSON.stringify(e.key)} is not "<kind> <identity>"`)
    if (seen.has(e.key)) throw new Error(`${m.id}: entry ${e.key} appears twice`)
    seen.add(e.key)
    // Without expectations an entry could only ever attribute by name, which is
    // exactly what this file exists to prevent.
    if (!e.expect || Object.keys(e.expect).length === 0) throw new Error(`${m.id}: entry ${e.key} declares no expectations`)
  }
}

export interface Attribution {
  difference: Difference
  bucket: Bucket
  /** Manifest id, when one claimed it. */
  source: string | null
  reason: string
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function mismatches(expect: Record<string, unknown>, row: Row): string[] {
  return Object.keys(expect)
    .filter(f => !same(expect[f], row[f]))
    .map(f => `${f}: manifest ${JSON.stringify(expect[f])}, staging ${JSON.stringify(row[f] ?? null)}`)
}

/**
 * Attribute the objects staging holds that the current model does not describe.
 *
 * `differences` should be the `extra_in_right` entries of a P → C diff; anything
 * else is returned unexplained, because a missing or differing object is a gate
 * failure rather than something a manifest may excuse.
 */
export function attribute(differences: Difference[], manifests: Manifest[]): Attribution[] {
  for (const m of manifests) validateManifest(m)

  const byKey = new Map<string, Array<{ manifest: Manifest; entry: ManifestEntry }>>()
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      const list = byKey.get(entry.key) ?? []
      list.push({ manifest, entry })
      byKey.set(entry.key, list)
    }
  }

  return differences.map(difference => {
    if (difference.status !== 'extra_in_right') {
      return {
        difference,
        bucket: 'unexplained_divergence' as const,
        source: null,
        reason:
          difference.status === 'missing_in_right'
            ? 'required by the current model and absent from staging'
            : 'present in both but defined differently',
      }
    }

    const claims = byKey.get(difference.key) ?? []
    if (claims.length === 0) {
      return { difference, bucket: 'unexplained_divergence' as const, source: null, reason: 'no manifest names this object' }
    }

    const row = difference.right ?? {}
    const matched = claims.filter(c => mismatches(c.entry.expect, row).length === 0)
    if (matched.length === 1) {
      return {
        difference,
        bucket: matched[0].manifest.bucket,
        source: matched[0].manifest.id,
        reason: matched[0].entry.note ?? `matches ${matched[0].manifest.source}`,
      }
    }
    if (matched.length > 1) {
      return {
        difference,
        bucket: 'unexplained_divergence' as const,
        source: null,
        reason: `claimed by more than one manifest: ${matched.map(m => m.manifest.id).join(', ')}`,
      }
    }
    return {
      difference,
      bucket: 'unexplained_divergence' as const,
      source: null,
      reason: `named by ${claims.map(c => c.manifest.id).join(', ')} but the definition differs (${mismatches(claims[0].entry.expect, row).join('; ')})`,
    }
  })
}

export function countByBucket(attributions: Attribution[]): Record<Bucket, number> {
  const counts = {
    represented_in_schema_prisma: 0,
    known_legacy_sql_effect: 0,
    known_provisioning_effect: 0,
    expected_environmental_difference: 0,
    unexplained_divergence: 0,
  } as Record<Bucket, number>
  for (const a of attributions) counts[a.bucket]++
  return counts
}
