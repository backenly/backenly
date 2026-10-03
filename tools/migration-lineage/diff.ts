/**
 * Semantic difference between two catalog snapshots.
 *
 * Objects are keyed by identity (schema, relation, name, and for routines the
 * argument signature) and compared field by field. A name that matches while a
 * definition differs is a difference, not a match: that is the case a count-based
 * comparison misses, and the reason "both have 120 tables" proves nothing.
 *
 * Nothing here is normalised away. The fields listed per kind are exactly the
 * properties the acceptance gate says must not be normalised: types, nullability,
 * defaults, identity and generation, constraint and index definitions including
 * predicates and foreign-key actions, policy command, roles and expressions,
 * trigger timing, events and enablement, SECURITY DEFINER, and routine bodies
 * (compared by digest, because a live database's bodies are not printed).
 */

import type { Snapshot } from './probe/capture'

export type Row = Record<string, unknown>

export interface KindSpec {
  kind: string
  collection: keyof Snapshot
  key: (row: Row) => string
  fields: string[]
}

const q = (row: Row, field: string) => String(row[field] ?? '')

export const KINDS: KindSpec[] = [
  {
    // Compared by presence only. Ownership is environmental (a scratch database
    // and staging have different owners for the same schema), and a schema's
    // contents are compared as the objects below.
    kind: 'schema',
    collection: 'schemas',
    key: r => q(r, 'name'),
    fields: [],
  },
  {
    kind: 'table',
    collection: 'tables',
    key: r => `${q(r, 'schema')}.${q(r, 'name')}`,
    fields: ['kind', 'persistence', 'partition', 'rls', 'force_rls'],
  },
  {
    kind: 'column',
    collection: 'columns',
    key: r => `${q(r, 'schema')}.${q(r, 'table')}.${q(r, 'name')}`,
    fields: ['type', 'type_schema', 'udt', 'typtype', 'not_null', 'default_expr', 'identity', 'generated', 'collation'],
  },
  {
    kind: 'constraint',
    collection: 'constraints',
    key: r => `${q(r, 'schema')}.${q(r, 'table')}.${q(r, 'name')}`,
    fields: ['type', 'definition', 'deferrable', 'deferred', 'validated'],
  },
  {
    kind: 'index',
    collection: 'indexes',
    key: r => `${q(r, 'schema')}.${q(r, 'table')}.${q(r, 'name')}`,
    fields: ['definition', 'unique', 'primary', 'method', 'predicate', 'constraint_backed'],
  },
  {
    kind: 'type',
    collection: 'types',
    key: r => `${q(r, 'schema')}.${q(r, 'name')}`,
    fields: ['kind', 'labels', 'domain_base', 'domain_not_null', 'domain_checks', 'composite_attributes'],
  },
  {
    kind: 'sequence',
    collection: 'sequences',
    key: r => `${q(r, 'schema')}.${q(r, 'name')}`,
    fields: ['type', 'start', 'increment', 'min', 'max', 'cycle', 'owned_by'],
  },
  {
    kind: 'policy',
    collection: 'policies',
    key: r => `${q(r, 'schema')}.${q(r, 'table')}.${q(r, 'name')}`,
    fields: ['command', 'permissive', 'roles', 'role_count', 'using_expr', 'check_expr'],
  },
  {
    kind: 'trigger',
    collection: 'triggers',
    key: r => `${q(r, 'schema')}.${q(r, 'table')}.${q(r, 'name')}`,
    fields: ['definition', 'enabled', 'function'],
  },
  {
    kind: 'routine',
    collection: 'routines',
    key: r => `${q(r, 'schema')}.${q(r, 'name')}(${q(r, 'identity_args')})`,
    fields: ['result', 'kind', 'language', 'security_definer', 'volatility', 'strict', 'leakproof', 'config', 'body_sha256'],
  },
  {
    kind: 'view',
    collection: 'views',
    key: r => `${q(r, 'schema')}.${q(r, 'name')}`,
    fields: ['kind', 'definition'],
  },
  {
    kind: 'event_trigger',
    collection: 'eventTriggers',
    key: r => q(r, 'name'),
    fields: ['event', 'enabled', 'function', 'tags'],
  },
  {
    kind: 'extension',
    collection: 'extensions',
    key: r => q(r, 'name'),
    fields: ['version', 'schema'],
  },
]

export interface Difference {
  kind: string
  /** "<kind> <identity>", the key a manifest entry must name to attribute it. */
  key: string
  status: 'missing_in_right' | 'extra_in_right' | 'differs'
  fields?: Array<{ field: string; left: unknown; right: unknown }>
  left?: Row
  right?: Row
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function index(snapshot: Snapshot, spec: KindSpec): Map<string, Row> {
  const rows = (snapshot[spec.collection] as Row[]) ?? []
  const map = new Map<string, Row>()
  for (const row of rows) {
    const key = `${spec.kind} ${spec.key(row)}`
    if (map.has(key)) throw new Error(`snapshot holds two objects keyed ${key}`)
    map.set(key, row)
  }
  return map
}

/**
 * Differences from `left` to `right`.
 *
 * With P on the left and C on the right: `missing_in_right` is something the
 * current model requires and staging does not have, `differs` is something both
 * have but defined differently, and `extra_in_right` is something staging holds
 * that the model does not describe, which is what attribution has to explain.
 */
export function diffSnapshots(left: Snapshot, right: Snapshot): Difference[] {
  const out: Difference[] = []
  for (const spec of KINDS) {
    const l = index(left, spec)
    const r = index(right, spec)
    for (const [key, lrow] of l) {
      const rrow = r.get(key)
      if (!rrow) {
        out.push({ kind: spec.kind, key, status: 'missing_in_right', left: lrow })
        continue
      }
      const fields = spec.fields
        .filter(f => !same(lrow[f], rrow[f]))
        .map(f => ({ field: f, left: lrow[f] ?? null, right: rrow[f] ?? null }))
      if (fields.length) out.push({ kind: spec.kind, key, status: 'differs', fields, left: lrow, right: rrow })
    }
    for (const [key, rrow] of r) {
      if (!l.has(key)) out.push({ kind: spec.kind, key, status: 'extra_in_right', right: rrow })
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

export function countByKind(differences: Difference[]): Array<{ kind: string; missing: number; differs: number; extra: number }> {
  const counts = new Map<string, { kind: string; missing: number; differs: number; extra: number }>()
  for (const spec of KINDS) counts.set(spec.kind, { kind: spec.kind, missing: 0, differs: 0, extra: 0 })
  for (const d of differences) {
    const c = counts.get(d.kind)!
    if (d.status === 'missing_in_right') c.missing++
    else if (d.status === 'differs') c.differs++
    else c.extra++
  }
  return [...counts.values()].filter(c => c.missing || c.differs || c.extra)
}
