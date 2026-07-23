/**
 * Supabase import — the pure planning core.
 *
 * ⚠ The Supabase IMPORTER is dormant by design (route gated off, ~1–3 months —
 * see app/api/projects/[id]/import/supabase/route.ts). BUT this file is NOT
 * dead: `mapPgType` is also imported by lib/branches/engine.ts to map cloned
 * column types on branch merge. Keep this module intact regardless of the
 * importer's on/off state.
 *
 * Everything in this file is deterministic and side-effect free: it turns
 * introspection rows from a source Supabase Postgres into an ImportPlan that
 * the engine (supabase-importer.ts) executes through Backenly's governed
 * mutation path. Pure functions so the whole migration strategy is unit-
 * testable without a database (scripts/verify-supabase-import-plan.ts).
 *
 * Policy decisions encoded here:
 *   • `users` is platform-managed in Backenly (enable_auth owns it), so a
 *     source `public.users` becomes `profiles` — the same rename the blueprint
 *     validator applies to AI builds. FK references follow the rename.
 *   • UUID-pk tables import 1:1 (explicit ids preserved).
 *   • Non-UUID pks (Supabase's default bigint identity) are preserved in a
 *     `legacy_id` column; every FK that pointed at them copies into
 *     `<fk>_legacy` and a second pass rewrites the real `<fk>` UUID column by
 *     joining on legacy_id. Nothing is silently dropped.
 *   • Lossy type degradations (arrays→JSON, enums→TEXT, bytea→base64 TEXT)
 *     are explicit warnings with source-side cast expressions.
 *   • FK *constraints* are not created by the importer — Backenly's autonomy
 *     reconciler detects and proposes them through the normal governed loop.
 */

// ── introspection shapes (what the engine reads from the source DB) ───────────

export interface SourceColumn {
  name: string
  /** information_schema data_type, e.g. "uuid", "bigint", "ARRAY", "USER-DEFINED" */
  dataType: string
  /** udt_name, e.g. "_text" for text[], enum type name for USER-DEFINED */
  udtName: string
  isNullable: boolean
  isPrimaryKey: boolean
  referencedTable: string | null
  referencedColumn: string | null
  hasDefault: boolean
}

export interface SourceTable {
  name: string
  columns: SourceColumn[]
  rowCount: number
}

export interface SourcePolicy {
  table: string
  name: string
  command: string
  /** pg_policies.qual (USING expression) */
  qual: string | null
}

// ── plan shapes ────────────────────────────────────────────────────────────────

export interface PlanColumn {
  /** Destination column name */
  name: string
  /** Backenly executor type (TEXT | INTEGER | BIGINT | DECIMAL | BOOLEAN | TIMESTAMP | DATE | JSON | UUID) */
  type: string
  /** SQL expression evaluated against the SOURCE row when copying */
  sourceExpr: string
  warning?: string
}

export interface PlanFkRemap {
  /** UUID column to fill on the destination table */
  column: string
  /** Legacy carrier column on the destination table */
  legacyColumn: string
  /** Destination name of the referenced table */
  refTable: string
}

export interface TablePlan {
  sourceName: string
  targetName: string
  /** 'uuid' = ids copy verbatim · 'legacy' = bigint/text pk preserved in legacy_id · 'none' = no pk */
  pkKind: 'uuid' | 'legacy' | 'none'
  /** Source pk column name (for legacy copy) */
  pkColumn: string | null
  columns: PlanColumn[]
  /** FK uuid rewrites needed after all rows are copied */
  fkRemaps: PlanFkRemap[]
  /** FK pairs (column → refTable) worth reporting for the reconciler */
  fkReport: Array<{ column: string; refTable: string }>
  rowCount: number
  warnings: string[]
}

export interface PolicyPlan {
  table: string
  policy: string
  kind: 'own_rows' | 'public_read' | 'manual'
  /** own_rows: the column compared against auth.uid() */
  column?: string
  raw?: string
}

export interface ImportPlan {
  tables: TablePlan[]
  /** source name → target name for every renamed table */
  renames: Record<string, string>
  policies: PolicyPlan[]
  warnings: string[]
}

// ── type mapping ───────────────────────────────────────────────────────────────

/**
 * Map a source Postgres column type onto the executor vocabulary, with a
 * source-side cast expression when the copy is lossy or needs coercion.
 */
export function mapPgType(col: SourceColumn): { type: string; sourceExpr: string; warning?: string } {
  const dt = col.dataType.toLowerCase()
  const udt = col.udtName.toLowerCase()
  const q = `"${col.name}"`

  if (dt === 'uuid') return { type: 'UUID', sourceExpr: q }
  if (['text', 'character varying', 'character', 'citext', 'name'].includes(dt)) {
    return { type: 'TEXT', sourceExpr: q }
  }
  if (['smallint', 'integer'].includes(dt)) return { type: 'INTEGER', sourceExpr: q }
  if (dt === 'bigint') return { type: 'BIGINT', sourceExpr: q }
  if (['numeric', 'decimal', 'money', 'real', 'double precision'].includes(dt)) {
    return { type: 'DECIMAL', sourceExpr: q }
  }
  if (dt === 'boolean') return { type: 'BOOLEAN', sourceExpr: q }
  if (dt.startsWith('timestamp') || dt.startsWith('time')) return { type: 'TIMESTAMP', sourceExpr: q }
  if (dt === 'date') return { type: 'DATE', sourceExpr: q }
  if (['json', 'jsonb'].includes(dt)) return { type: 'JSON', sourceExpr: q }

  if (dt === 'array') {
    return {
      type: 'JSON',
      sourceExpr: `to_jsonb(${q})`,
      warning: `${col.name}: array type ${udt} stored as JSON — update code that expected a Postgres array`,
    }
  }
  if (dt === 'user-defined' && udt === 'vector') {
    return {
      type: 'TEXT',
      sourceExpr: `${q}::text`,
      warning: `${col.name}: pgvector embedding copied as TEXT — recreate the vector column via Backenly chat ("add vector search to …") and re-embed`,
    }
  }
  if (dt === 'user-defined') {
    return {
      type: 'TEXT',
      sourceExpr: `${q}::text`,
      warning: `${col.name}: enum ${udt} stored as TEXT — enum constraint not carried over`,
    }
  }
  if (dt === 'bytea') {
    return {
      type: 'TEXT',
      sourceExpr: `encode(${q}, 'base64')`,
      warning: `${col.name}: binary data base64-encoded into TEXT — consider moving blobs to Backenly Storage`,
    }
  }
  return {
    type: 'TEXT',
    sourceExpr: `${q}::text`,
    warning: `${col.name}: unrecognised type ${dt}/${udt} copied as TEXT`,
  }
}

// ── table renames ──────────────────────────────────────────────────────────────

/** Backenly-reserved source names and their destination mapping. */
export function targetTableName(sourceName: string): { name: string; renamed: boolean } {
  const lower = sourceName.toLowerCase()
  if (lower === 'users') return { name: 'profiles', renamed: true }
  if (lower === 'profiles') return { name: 'profiles', renamed: false }
  return { name: sourceName, renamed: false }
}

// ── topological ordering (parents before children) ────────────────────────────

export function topoSortTables(tables: SourceTable[]): { order: string[]; cyclic: string[] } {
  const names = new Set(tables.map((t) => t.name))
  const deps = new Map<string, Set<string>>()
  for (const t of tables) {
    const set = new Set<string>()
    for (const c of t.columns) {
      if (c.referencedTable && c.referencedTable !== t.name && names.has(c.referencedTable)) {
        set.add(c.referencedTable)
      }
    }
    deps.set(t.name, set)
  }

  const order: string[] = []
  const remaining = new Set(names)
  while (remaining.size > 0) {
    const ready = [...remaining].filter((n) => [...deps.get(n)!].every((d) => !remaining.has(d)))
    if (ready.length === 0) break // cycle — append the rest in stable order
    ready.sort()
    for (const n of ready) {
      order.push(n)
      remaining.delete(n)
    }
  }
  const cyclic = [...remaining].sort()
  order.push(...cyclic)
  return { order, cyclic }
}

// ── RLS policy classification ──────────────────────────────────────────────────

const OWN_ROWS_RE = /auth\.uid\(\)\s*(?:::text\s*)?=\s*\(?\s*"?([a-z_][a-z0-9_]*)"?|"?([a-z_][a-z0-9_]*)"?\s*=\s*(?:\(\s*)?auth\.uid\(\)/i

export function classifyPolicy(p: SourcePolicy): PolicyPlan {
  const qual = (p.qual ?? '').trim()
  if (!qual || qual === 'true') {
    return { table: p.table, policy: p.name, kind: 'public_read' }
  }
  const m = qual.match(OWN_ROWS_RE)
  if (m) {
    const column = (m[1] ?? m[2] ?? '').replace(/^\(+|\)+$/g, '')
    if (column && column !== 'uid') {
      return { table: p.table, policy: p.name, kind: 'own_rows', column }
    }
  }
  return { table: p.table, policy: p.name, kind: 'manual', raw: qual }
}

// ── the plan builder ───────────────────────────────────────────────────────────

const AUTO_COLUMNS = new Set(['id', 'createdat', 'updatedat'])
const SUPABASE_INTERNAL_TABLES = new Set(['schema_migrations', 'supabase_functions', 'secrets'])

export function buildImportPlan(tables: SourceTable[], policies: SourcePolicy[] = []): ImportPlan {
  const warnings: string[] = []
  const renames: Record<string, string> = {}

  const usable = tables.filter((t) => {
    if (SUPABASE_INTERNAL_TABLES.has(t.name.toLowerCase())) {
      warnings.push(`Skipped internal table "${t.name}"`)
      return false
    }
    return true
  })

  for (const t of usable) {
    const { name, renamed } = targetTableName(t.name)
    renames[t.name] = name
    if (renamed) {
      warnings.push(
        `"${t.name}" imported as "${name}" — Backenly's auth system owns the users table; ` +
        `auth identities import separately and profiles keeps your extra fields`,
      )
    }
  }

  // pk kind per source table — needed before FK planning
  const pkKind = new Map<string, 'uuid' | 'legacy' | 'none'>()
  const pkColumn = new Map<string, string | null>()
  for (const t of usable) {
    const pk = t.columns.find((c) => c.isPrimaryKey)
    if (!pk) {
      pkKind.set(t.name, 'none')
      pkColumn.set(t.name, null)
    } else if (pk.dataType.toLowerCase() === 'uuid') {
      pkKind.set(t.name, 'uuid')
      pkColumn.set(t.name, pk.name)
    } else {
      pkKind.set(t.name, 'legacy')
      pkColumn.set(t.name, pk.name)
    }
  }

  const { order, cyclic } = topoSortTables(usable)
  if (cyclic.length > 0) {
    warnings.push(`Circular FK references between: ${cyclic.join(', ')} — imported in name order; FK rewiring may need a manual pass`)
  }
  const byName = new Map(usable.map((t) => [t.name, t]))

  const tablePlans: TablePlan[] = []
  for (const sourceName of order) {
    const t = byName.get(sourceName)!
    const kind = pkKind.get(sourceName)!
    const tWarnings: string[] = []
    const columns: PlanColumn[] = []
    const fkRemaps: PlanFkRemap[] = []
    const fkReport: Array<{ column: string; refTable: string }> = []

    // Legacy pk carrier
    if (kind === 'legacy') {
      columns.push({
        name: 'legacy_id',
        type: 'BIGINT',
        sourceExpr: `"${pkColumn.get(sourceName)!}"`,
        warning: `${sourceName}: primary key is ${pkColumn.get(sourceName)} (non-UUID) — preserved as legacy_id; new UUID ids assigned`,
      })
      tWarnings.push(`Non-UUID primary key preserved in legacy_id; relations rewired to new UUIDs automatically`)
    }

    for (const c of t.columns) {
      const lower = c.name.toLowerCase()
      if (c.isPrimaryKey) {
        if (kind === 'uuid') {
          // id copies verbatim into the auto uuid pk — handled by the engine
          // (insert lists id explicitly). Nothing to plan here.
          continue
        }
        continue // legacy pk already carried via legacy_id
      }
      if (AUTO_COLUMNS.has(lower.replace(/_/g, ''))) {
        // created_at / updated_at → auto columns exist; copy source values in.
        if (lower === 'created_at' || lower === 'updated_at') {
          columns.push({
            name: lower === 'created_at' ? 'createdAt' : 'updatedAt',
            type: 'TIMESTAMP',
            sourceExpr: `"${c.name}"`,
          })
          continue
        }
      }

      const isFk = !!c.referencedTable
      if (isFk && c.referencedTable && pkKind.get(c.referencedTable) === 'legacy') {
        // FK to a legacy-pk table: carry source value, rewrite to UUID later.
        columns.push({
          name: `${c.name}_legacy`,
          type: 'BIGINT',
          sourceExpr: `"${c.name}"`,
        })
        columns.push({ name: c.name, type: 'UUID', sourceExpr: 'NULL' })
        fkRemaps.push({
          column: c.name,
          legacyColumn: `${c.name}_legacy`,
          refTable: renames[c.referencedTable] ?? c.referencedTable,
        })
        fkReport.push({ column: c.name, refTable: renames[c.referencedTable] ?? c.referencedTable })
        continue
      }

      const mapped = mapPgType(c)
      if (mapped.warning) tWarnings.push(mapped.warning)
      columns.push({ name: c.name, type: mapped.type, sourceExpr: mapped.sourceExpr, warning: mapped.warning })

      if (isFk && c.referencedTable) {
        fkReport.push({ column: c.name, refTable: renames[c.referencedTable] ?? c.referencedTable })
      }
      if (c.hasDefault) {
        tWarnings.push(`${c.name}: source default not carried over — Backenly manages defaults`)
      }
    }

    tablePlans.push({
      sourceName,
      targetName: renames[sourceName] ?? sourceName,
      pkKind: kind,
      pkColumn: pkColumn.get(sourceName) ?? null,
      columns,
      fkRemaps,
      fkReport,
      rowCount: t.rowCount,
      warnings: tWarnings,
    })
  }

  const policyPlans = policies
    .filter((p) => byName.has(p.table))
    .map((p) => classifyPolicy({ ...p, table: renames[p.table] ?? p.table }))

  return { tables: tablePlans, renames, policies: policyPlans, warnings }
}
