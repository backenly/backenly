/**
 * Unit verifier for the Supabase import planning core (lib/import/supabase-map.ts).
 * Pure functions, realistic fixtures, no database.
 *
 * Run: npx tsx scripts/verify-supabase-import-plan.ts
 */
import {
  buildImportPlan,
  mapPgType,
  topoSortTables,
  classifyPolicy,
  type SourceTable,
  type SourceColumn,
} from '../lib/import/supabase-map'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++
  console.log(`${ok ? '✔' : '✖'} ${label}${!ok && detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`)
}

function col(partial: Partial<SourceColumn> & { name: string }): SourceColumn {
  return {
    dataType: 'text',
    udtName: 'text',
    isNullable: true,
    isPrimaryKey: false,
    referencedTable: null,
    referencedColumn: null,
    hasDefault: false,
    ...partial,
  }
}

// ── fixture: a typical Supabase project ────────────────────────────────────────
// users: uuid pk (Supabase auth-linked profile table pattern)
// posts: bigint identity pk (Supabase table-editor default), fk → users, array + enum cols
// comments: bigint pk, fk → posts (legacy) and users (uuid)

const users: SourceTable = {
  name: 'users',
  rowCount: 3,
  columns: [
    col({ name: 'id', dataType: 'uuid', udtName: 'uuid', isPrimaryKey: true }),
    col({ name: 'username', dataType: 'text', udtName: 'text' }),
    col({ name: 'created_at', dataType: 'timestamp with time zone', udtName: 'timestamptz', hasDefault: true }),
  ],
}

const posts: SourceTable = {
  name: 'posts',
  rowCount: 10,
  columns: [
    col({ name: 'id', dataType: 'bigint', udtName: 'int8', isPrimaryKey: true, hasDefault: true }),
    col({ name: 'title', dataType: 'text', udtName: 'text' }),
    col({ name: 'author_id', dataType: 'uuid', udtName: 'uuid', referencedTable: 'users', referencedColumn: 'id' }),
    col({ name: 'tags', dataType: 'ARRAY', udtName: '_text' }),
    col({ name: 'status', dataType: 'USER-DEFINED', udtName: 'post_status' }),
    col({ name: 'embedding', dataType: 'USER-DEFINED', udtName: 'vector' }),
  ],
}

const comments: SourceTable = {
  name: 'comments',
  rowCount: 25,
  columns: [
    col({ name: 'id', dataType: 'bigint', udtName: 'int8', isPrimaryKey: true }),
    col({ name: 'body', dataType: 'text', udtName: 'text' }),
    col({ name: 'post_id', dataType: 'bigint', udtName: 'int8', referencedTable: 'posts', referencedColumn: 'id' }),
    col({ name: 'user_id', dataType: 'uuid', udtName: 'uuid', referencedTable: 'users', referencedColumn: 'id' }),
  ],
}

const plan = buildImportPlan([comments, posts, users], [
  { table: 'posts', name: 'own rows', command: 'ALL', qual: '(auth.uid() = author_id)' },
  { table: 'posts', name: 'anyone reads', command: 'SELECT', qual: 'true' },
  { table: 'comments', name: 'weird', command: 'ALL', qual: "(tenant_id = current_setting('app.tenant')::uuid)" },
])

// ── renames ────────────────────────────────────────────────────────────────────
check('users renamed to profiles', plan.renames['users'] === 'profiles', plan.renames)
const profiles = plan.tables.find((t) => t.targetName === 'profiles')
check('profiles plan exists with uuid pk', profiles?.pkKind === 'uuid', profiles?.pkKind)

// ── topo order: parents before children ───────────────────────────────────────
const order = plan.tables.map((t) => t.sourceName)
check(
  'topological order users → posts → comments',
  order.indexOf('users') < order.indexOf('posts') && order.indexOf('posts') < order.indexOf('comments'),
  order,
)

// ── posts (legacy pk + degradations) ──────────────────────────────────────────
const p = plan.tables.find((t) => t.sourceName === 'posts')!
check('posts pkKind is legacy', p.pkKind === 'legacy')
check('posts carries legacy_id BIGINT', p.columns.some((c) => c.name === 'legacy_id' && c.type === 'BIGINT'))
check('tags array → JSON via to_jsonb', p.columns.some((c) => c.name === 'tags' && c.type === 'JSON' && c.sourceExpr.includes('to_jsonb')))
check('enum status → TEXT with cast', p.columns.some((c) => c.name === 'status' && c.type === 'TEXT' && c.sourceExpr.includes('::text')))
check('pgvector column degraded with re-embed warning', p.warnings.some((w) => w.includes('re-embed')))
check('author_id fk (uuid parent) stays UUID, no remap', p.columns.some((c) => c.name === 'author_id' && c.type === 'UUID') && p.fkRemaps.length === 0)
check('author_id fk reported against renamed profiles', p.fkReport.some((f) => f.column === 'author_id' && f.refTable === 'profiles'), p.fkReport)

// ── comments (fk into a legacy-pk table) ──────────────────────────────────────
const c = plan.tables.find((t) => t.sourceName === 'comments')!
check('comments.post_id carried as post_id_legacy BIGINT', c.columns.some((x) => x.name === 'post_id_legacy' && x.type === 'BIGINT'))
check('comments.post_id planned as UUID (filled by remap)', c.columns.some((x) => x.name === 'post_id' && x.type === 'UUID' && x.sourceExpr === 'NULL'))
check('comments has fkRemap post_id → posts via post_id_legacy', c.fkRemaps.some((r) => r.column === 'post_id' && r.legacyColumn === 'post_id_legacy' && r.refTable === 'posts'), c.fkRemaps)

// ── auto-column mapping ────────────────────────────────────────────────────────
const prof = plan.tables.find((t) => t.sourceName === 'users')!
check('created_at maps onto auto createdAt', prof.columns.some((x) => x.name === 'createdAt' && x.sourceExpr === '"created_at"'))

// ── policies ───────────────────────────────────────────────────────────────────
check('auth.uid() = author_id → own_rows(author_id)', plan.policies.some((x) => x.kind === 'own_rows' && x.column === 'author_id' && x.table === 'posts'), plan.policies)
check('USING(true) → public_read', plan.policies.some((x) => x.kind === 'public_read'))
check('complex qual → manual with raw preserved', plan.policies.some((x) => x.kind === 'manual' && x.raw?.includes('tenant_id')))

// ── cycles ─────────────────────────────────────────────────────────────────────
const a: SourceTable = { name: 'a', rowCount: 0, columns: [col({ name: 'b_id', referencedTable: 'b' })] }
const b: SourceTable = { name: 'b', rowCount: 0, columns: [col({ name: 'a_id', referencedTable: 'a' })] }
const cyc = topoSortTables([a, b])
check('cycle detected and still fully ordered', cyc.cyclic.length === 2 && cyc.order.length === 2, cyc)

// ── type mapper spot checks ────────────────────────────────────────────────────
check('bytea → base64 TEXT', mapPgType(col({ name: 'blob', dataType: 'bytea', udtName: 'bytea' })).sourceExpr.includes('base64'))
check('numeric → DECIMAL', mapPgType(col({ name: 'price', dataType: 'numeric', udtName: 'numeric' })).type === 'DECIMAL')
check('unknown type degrades to TEXT with warning', (() => { const m = mapPgType(col({ name: 'x', dataType: 'tsvector', udtName: 'tsvector' })); return m.type === 'TEXT' && !!m.warning })())

// ── policy classifier edge: reversed operand order ────────────────────────────
check('user_id = auth.uid() (reversed) → own_rows', classifyPolicy({ table: 't', name: 'p', command: 'ALL', qual: '(user_id = auth.uid())' }).kind === 'own_rows')

if (failures > 0) {
  console.error(`\n✖ ${failures} import-plan verification(s) failed`)
  process.exitCode = 1
} else {
  console.log('\n✔ Supabase import planning core verified')
}
