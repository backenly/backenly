/**
 * Firestore → Backenly tables: the pure half of the Firebase importer.
 *
 * Deterministic and free of I/O, so every rule here is unit-tested without a
 * database or a network (__tests__/import/firebase-schema.test.ts):
 *
 *   • A top-level collection is a table; a subcollection is `{parent}_{child}`
 *     with `parent_id`, the parent row's id. `users` is Backenly's sign-in
 *     table, so a `users` collection arrives as `profiles` (as Supabase's does).
 *   • Each row keeps its document id in `firebase_id`. In a top-level table it
 *     is unique; in a subcollection ids repeat from parent to parent, so it is
 *     unique together with parent_id. Backenly's own `id` is a uuid derived from
 *     the document's full path under a per-import secret, so a child's
 *     parent_id is known without looking anything up and never guessable.
 *   • Column types come from up to 1,000 documents read per collection:
 *     string → text, integer → bigint, double → double precision (integers mixed
 *     with doubles too, as every JavaScript client writes them), boolean,
 *     timestamp → timestamptz, map/array/geopoint → jsonb, reference → text
 *     (the document path), bytes → base64 text, and anything mixed, or only
 *     ever null, → jsonb.
 *   • A value that does not fit its column (a field first seen later, or one
 *     that changed type) is kept, never dropped: it goes into an `extra_fields`
 *     jsonb column, added when the first such value arrives.
 *   • Names are safe identifiers, unique the way the table builder compares
 *     them (lowercase, underscores ignored), never Backenly's own columns.
 */

import { createHash, createHmac } from 'crypto'

// ── Firestore's REST shapes ───────────────────────────────────────────────────

export interface FsValue {
  nullValue?: null | string
  booleanValue?: boolean
  integerValue?: string | number
  doubleValue?: number | string
  timestampValue?: string
  stringValue?: string
  bytesValue?: string
  referenceValue?: string
  geoPointValue?: { latitude?: number; longitude?: number }
  arrayValue?: { values?: FsValue[] }
  mapValue?: { fields?: Record<string, FsValue> }
}

export interface FsDocument {
  /** projects/{p}/databases/{db}/documents/{path} */
  name: string
  fields?: Record<string, FsValue>
  createTime?: string
  updateTime?: string
}

export type ValueKind =
  | 'null' | 'boolean' | 'integer' | 'double' | 'timestamp' | 'string'
  | 'bytes' | 'reference' | 'geopoint' | 'array' | 'map' | 'unknown'

export function kindOf(v: FsValue | null | undefined): ValueKind {
  if (!v || typeof v !== 'object') return 'unknown'
  if ('nullValue' in v) return 'null'
  if ('booleanValue' in v) return 'boolean'
  if ('integerValue' in v) return 'integer'
  if ('doubleValue' in v) return 'double'
  if ('timestampValue' in v) return 'timestamp'
  if ('stringValue' in v) return 'string'
  if ('bytesValue' in v) return 'bytes'
  if ('referenceValue' in v) return 'reference'
  if ('geoPointValue' in v) return 'geopoint'
  if ('arrayValue' in v) return 'array'
  if ('mapValue' in v) return 'map'
  return 'unknown'
}

// ── Paths ──────────────────────────────────────────────────────────────────────

export interface DocLocation {
  /** Path below the database root: posts/a/comments/b */
  path: string
  /** The document's own id: b */
  id: string
  /** The parent document's path, or null for a top-level document: posts/a */
  parentPath: string | null
  /** Collection ids from the top: ['posts', 'comments'] */
  collections: string[]
  /** 'posts' or 'posts/*\/comments' */
  pattern: string
}

/** Where a document sits, from its resource name. Null for a name outside `root`. */
export function locate(name: string, root: string): DocLocation | null {
  const prefix = `${root}/`
  if (!name.startsWith(prefix)) return null
  const path = name.slice(prefix.length)
  const segs = path.split('/')
  if (segs.length < 2 || segs.length % 2 !== 0 || segs.some((s) => s === '')) return null
  const collections = segs.filter((_, i) => i % 2 === 0)
  return {
    path,
    id: segs[segs.length - 1],
    parentPath: segs.length > 2 ? segs.slice(0, -2).join('/') : null,
    collections,
    pattern: collections.join('/*/'),
  }
}

/** 'posts/*\/comments' → 'posts/{id}/comments', the way a person reads a path. */
export function displayPattern(pattern: string): string {
  return pattern.split('/*/').join('/{id}/')
}

/** A reference value as a path below the root when it points into the same database. */
export function referencePath(ref: string, root: string): string {
  return ref.startsWith(`${root}/`) ? ref.slice(root.length + 1) : ref
}

// ── Names ──────────────────────────────────────────────────────────────────────

const MAX_IDENT = 63

function ascii(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

function shortHash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)
}

/** A collection id as a table-name part: snake_case, lowercase, safe. */
export function tableNamePart(collectionId: string): string {
  let s = ascii(collectionId)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!s) s = 'collection'
  if (/^[0-9]/.test(s)) s = `c_${s}`
  return s
}

/** Table names Backenly keeps for itself, and what a collection of that name becomes. */
const RESERVED_TABLES: Record<string, string> = { users: 'profiles' }

function fitIdent(name: string, uniqueBy: string): string {
  if (name.length <= MAX_IDENT) return name
  return `${name.slice(0, MAX_IDENT - 9).replace(/_+$/, '')}_${shortHash(uniqueBy)}`
}

/**
 * Table names for collection patterns, assigned once each and never twice.
 * Assign in a stable order (assignAll) so the preview and the import agree.
 */
export class TableNames {
  private readonly byPattern = new Map<string, string>()
  private readonly taken = new Set<string>()

  constructor(reserved: Iterable<string> = ['users']) {
    for (const r of reserved) this.taken.add(r)
  }

  /** Patterns sorted parents-first, then by name: the order names are given in. */
  static order(patterns: Iterable<string>): string[] {
    return [...new Set(patterns)].sort((a, b) => {
      const da = a.split('/*/').length
      const db = b.split('/*/').length
      return da !== db ? da - db : a < b ? -1 : a > b ? 1 : 0
    })
  }

  assignAll(patterns: Iterable<string>): void {
    for (const p of TableNames.order(patterns)) this.nameFor(p)
  }

  has(pattern: string): boolean {
    return this.byPattern.has(pattern)
  }

  nameFor(pattern: string): string {
    const known = this.byPattern.get(pattern)
    if (known) return known
    const collections = pattern.split('/*/')
    let base: string
    if (collections.length === 1) {
      const part = tableNamePart(collections[0])
      base = RESERVED_TABLES[part] ?? part
    } else {
      const parent = this.nameFor(collections.slice(0, -1).join('/*/'))
      base = `${parent}_${tableNamePart(collections[collections.length - 1])}`
    }
    base = fitIdent(base, pattern)
    let name = base
    for (let n = 2; this.taken.has(name); n++) {
      const suffix = `_${n}`
      name = `${base.slice(0, MAX_IDENT - suffix.length)}${suffix}`
    }
    this.taken.add(name)
    this.byPattern.set(pattern, name)
    return name
  }

  /** The renamed-collection note, when a reserved name moved a table. */
  static renameNote(pattern: string, table: string): string | null {
    if (pattern.includes('/*/')) return null
    const part = tableNamePart(pattern)
    if (RESERVED_TABLES[part] && table.startsWith(RESERVED_TABLES[part])) {
      return `${part} is Backenly's sign-in table, so these documents arrive in ${table}.`
    }
    return null
  }
}

/** How the table builder compares column names: lowercase, underscores ignored. */
export function columnKey(name: string): string {
  return name.toLowerCase().replace(/_/g, '')
}

/** Columns every imported table has, or Backenly adds itself. */
const RESERVED_COLUMN_KEYS = new Set(['id', 'createdat', 'updatedat', 'deletedat', 'firebaseid', 'parentid', 'extrafields'])

/** A field name as a safe column name (case kept: apps read these names). */
export function columnNamePart(field: string): string {
  let s = ascii(field).replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!s) s = 'field'
  if (/^[0-9]/.test(s)) s = `f_${s}`
  return s.length > MAX_IDENT ? `${s.slice(0, MAX_IDENT - 9)}_${shortHash(field)}` : s
}

function uniqueColumn(base: string, taken: Set<string>): string {
  let name = base
  for (let n = 2; taken.has(columnKey(name)); n++) {
    const suffix = `_${n}`
    name = `${base.slice(0, MAX_IDENT - suffix.length)}${suffix}`
  }
  taken.add(columnKey(name))
  return name
}

// ── Profiles and types ────────────────────────────────────────────────────────

export type ColumnType = 'text' | 'bigint' | 'double precision' | 'boolean' | 'timestamptz' | 'jsonb' | 'uuid'

export interface FieldProfile {
  field: string
  kinds: Map<ValueKind, number>
  /** Documents that had the field at all (null included). */
  present: number
  /** Integers past 2^53 seen; they lose precision in a double column. */
  hugeIntegers: number
}

const SAFE_INT = BigInt(Number.MAX_SAFE_INTEGER)

/** What up to N documents of one collection pattern look like. */
export class CollectionProfile {
  docs = 0
  /** Approximate bytes of the documents read (their JSON). */
  bytes = 0
  readonly fields = new Map<string, FieldProfile>()

  add(doc: FsDocument): void {
    this.docs++
    this.bytes += approxBytes(doc)
    for (const [field, value] of Object.entries(doc.fields ?? {})) {
      let p = this.fields.get(field)
      if (!p) {
        p = { field, kinds: new Map(), present: 0, hugeIntegers: 0 }
        this.fields.set(field, p)
      }
      p.present++
      const k = kindOf(value)
      p.kinds.set(k, (p.kinds.get(k) ?? 0) + 1)
      if (k === 'integer') {
        try {
          const n = BigInt(String(value.integerValue))
          if (n > SAFE_INT || n < -SAFE_INT) p.hugeIntegers++
        } catch {
          /* not an integer after all: it will not fit a bigint column, and lands in extra_fields */
        }
      }
    }
  }
}

function approxBytes(doc: FsDocument): number {
  try {
    return Buffer.byteLength(JSON.stringify(doc.fields ?? {}), 'utf8')
  } catch {
    return 0
  }
}

const JSON_KINDS = new Set<ValueKind>(['map', 'array', 'geopoint'])

/** A column type from the kinds a field held. */
export function inferColumnType(kinds: Iterable<ValueKind>): { type: ColumnType; mixed: boolean } {
  const set = new Set(kinds)
  set.delete('null')
  if (set.size === 0) return { type: 'jsonb', mixed: false }
  if (set.has('unknown')) return { type: 'jsonb', mixed: true }
  if (set.size === 1) {
    const only = [...set][0]
    switch (only) {
      case 'string': return { type: 'text', mixed: false }
      case 'integer': return { type: 'bigint', mixed: false }
      case 'double': return { type: 'double precision', mixed: false }
      case 'boolean': return { type: 'boolean', mixed: false }
      case 'timestamp': return { type: 'timestamptz', mixed: false }
      case 'reference': return { type: 'text', mixed: false }
      case 'bytes': return { type: 'text', mixed: false }
      default: return { type: 'jsonb', mixed: false }
    }
  }
  if ([...set].every((k) => k === 'integer' || k === 'double')) return { type: 'double precision', mixed: false }
  if ([...set].every((k) => JSON_KINDS.has(k))) return { type: 'jsonb', mixed: false }
  return { type: 'jsonb', mixed: true }
}

// ── The plan for one table ─────────────────────────────────────────────────────

export type ColumnSource =
  | { kind: 'rowId' }
  | { kind: 'docId' }
  | { kind: 'parent' }
  | { kind: 'createTime'; field: string | null }
  | { kind: 'updateTime'; field: string | null }
  | { kind: 'field'; field: string }
  | { kind: 'extra' }

export interface PlannedColumn {
  name: string
  type: ColumnType
  source: ColumnSource
  unique?: boolean
}

export interface TablePlan {
  pattern: string
  /** For people: posts, or posts/{id}/comments */
  sourceName: string
  name: string
  parentTable: string | null
  /** Columns the table is created with (Backenly adds id, createdAt, updatedAt, deleted_at itself). */
  createColumns: PlannedColumn[]
  /** Every column a row is written with, in order (extra_fields, when present, is appended by writeColumns). */
  insertColumns: PlannedColumn[]
  /** Field → its column, for fields that have one. */
  fieldColumns: Map<string, PlannedColumn>
  /** Whether extra_fields exists (planned, or added during the import). */
  extraColumn: boolean
  notes: string[]
  /** Documents the types were read from. */
  sampled: number
}

export const MAX_FIELD_COLUMNS = 250

function listNames(names: string[], max = 3): string {
  const quoted = names.slice(0, max).map((n) => `"${n}"`)
  const rest = names.length - quoted.length
  if (rest > 0) return `${quoted.join(', ')} and ${rest} more`
  if (quoted.length <= 1) return quoted.join('')
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}

/**
 * The table for one collection pattern, from what its documents looked like.
 * `total` is how many documents the pattern holds when known; fewer sampled
 * than that means later documents may bring fields the sample never saw.
 */
export function planTable(input: {
  pattern: string
  name: string
  parentTable: string | null
  profile: CollectionProfile
  total: number | null
}): TablePlan {
  const { pattern, name, parentTable, profile } = input
  const isChild = parentTable !== null
  const taken = new Set<string>(RESERVED_COLUMN_KEYS)
  const notes: string[] = []

  const rename = TableNames.renameNote(pattern, name)
  if (rename) notes.push(rename)

  // Fields, most common first when there are too many to all be columns.
  let fields = [...profile.fields.values()]
  let overflow: string[] = []
  if (fields.length > MAX_FIELD_COLUMNS) {
    const ranked = [...fields].sort((a, b) => b.present - a.present || (a.field < b.field ? -1 : 1))
    overflow = ranked.slice(MAX_FIELD_COLUMNS).map((f) => f.field)
    fields = ranked.slice(0, MAX_FIELD_COLUMNS)
  }
  fields.sort((a, b) => {
    const x = a.field.toLowerCase()
    const y = b.field.toLowerCase()
    return x < y ? -1 : x > y ? 1 : a.field < b.field ? -1 : 1
  })

  const fieldColumns = new Map<string, PlannedColumn>()
  const renamed: string[] = []
  const mixed: string[] = []
  const nullOnly: string[] = []
  const binary: string[] = []
  const lossy: string[] = []
  let createdFrom: string | null = null
  let updatedFrom: string | null = null

  for (const f of fields) {
    const { type, mixed: isMixed } = inferColumnType(f.kinds.keys())
    const key = columnKey(f.field)
    // A timestamp field named createdAt / updatedAt fills Backenly's own column.
    if (type === 'timestamptz' && key === 'createdat' && !createdFrom) {
      createdFrom = f.field
      continue
    }
    if (type === 'timestamptz' && key === 'updatedat' && !updatedFrom) {
      updatedFrom = f.field
      continue
    }
    let base = columnNamePart(f.field)
    if (RESERVED_COLUMN_KEYS.has(columnKey(base))) base = `${base}_firebase`
    const col = uniqueColumn(base, taken)
    if (col !== f.field) renamed.push(`"${f.field}" → ${col}`)
    if (isMixed) mixed.push(f.field)
    if ([...f.kinds.keys()].every((k) => k === 'null')) nullOnly.push(f.field)
    if (f.kinds.has('bytes') && type === 'text') binary.push(f.field)
    if (type === 'double precision' && f.hugeIntegers > 0) lossy.push(f.field)
    fieldColumns.set(f.field, { name: col, type, source: { kind: 'field', field: f.field } })
  }

  const createColumns: PlannedColumn[] = [
    { name: 'firebase_id', type: 'text', source: { kind: 'docId' }, ...(isChild ? {} : { unique: true }) },
    ...(isChild ? [{ name: 'parent_id', type: 'uuid' as ColumnType, source: { kind: 'parent' } as ColumnSource }] : []),
    ...fieldColumns.values(),
  ]
  const extraColumn = overflow.length > 0
  if (extraColumn) createColumns.push({ name: 'extra_fields', type: 'jsonb', source: { kind: 'extra' } })

  // Notes, most useful first.
  notes.push(isChild ? `Document ids are in firebase_id; parent_id is the id of the ${parentTable} row each one belongs to.` : 'Document ids are in firebase_id.')
  if (input.total !== null && profile.docs < input.total) {
    notes.push(`Column types come from ${profile.docs.toLocaleString('en-US')} of ${input.total.toLocaleString('en-US')} documents; a field first seen later goes into extra_fields.`)
  }
  if (createdFrom || updatedFrom) {
    const which = [createdFrom, updatedFrom].filter(Boolean) as string[]
    notes.push(`${listNames(which)} ${which.length > 1 ? 'fill' : 'fills'} Backenly's own ${[createdFrom ? 'createdAt' : null, updatedFrom ? 'updatedAt' : null].filter(Boolean).join(' and ')}.`)
  }
  if (mixed.length) notes.push(`${listNames(mixed)} ${mixed.length > 1 ? 'hold' : 'holds'} more than one kind of value, so ${mixed.length > 1 ? 'they are' : 'it is'} stored as JSON.`)
  if (nullOnly.length) notes.push(`${listNames(nullOnly)} ${nullOnly.length > 1 ? 'are' : 'is'} empty in every document read, so stored as JSON.`)
  if (binary.length) notes.push(`${listNames(binary)} ${binary.length > 1 ? 'hold' : 'holds'} binary data, stored as base64 text.`)
  if (lossy.length) notes.push(`${listNames(lossy)} ${lossy.length > 1 ? 'mix' : 'mixes'} decimals with integers too large for double precision; those integers lose precision.`)
  if (renamed.length) notes.push(`Renamed to fit SQL: ${renamed.slice(0, 3).join(', ')}${renamed.length > 3 ? ` and ${renamed.length - 3} more` : ''}.`)
  if (overflow.length) notes.push(`${overflow.length.toLocaleString('en-US')} rarely used fields are kept together in extra_fields.`)

  const plan: TablePlan = {
    pattern,
    sourceName: displayPattern(pattern),
    name,
    parentTable,
    createColumns,
    insertColumns: [],
    fieldColumns,
    extraColumn,
    notes,
    sampled: profile.docs,
  }
  rebuildInsertColumns(plan, createdFrom, updatedFrom)
  return plan
}

/** The write order: id, createdAt, updatedAt, then the created columns (not extra_fields). */
function rebuildInsertColumns(plan: TablePlan, createdFrom: string | null, updatedFrom: string | null): void {
  plan.insertColumns = [
    { name: 'id', type: 'uuid', source: { kind: 'rowId' } },
    { name: 'createdAt', type: 'timestamptz', source: { kind: 'createTime', field: createdFrom } },
    { name: 'updatedAt', type: 'timestamptz', source: { kind: 'updateTime', field: updatedFrom } },
    ...plan.createColumns.filter((c) => c.source.kind !== 'extra'),
  ]
}

export const EXTRA_COLUMN: PlannedColumn = { name: 'extra_fields', type: 'jsonb', source: { kind: 'extra' } }

/** The columns a row of `plan` is written with: insertColumns, then extra_fields when the table has it. */
export function writeColumns(plan: TablePlan): PlannedColumn[] {
  return plan.extraColumn ? [...plan.insertColumns, EXTRA_COLUMN] : plan.insertColumns
}

/** One converted row as written to `plan`'s writeColumns. */
export function writeRow(plan: TablePlan, row: ConvertedRow): unknown[] {
  return plan.extraColumn ? [...row.values, row.extra] : row.values
}

// ── Rows ───────────────────────────────────────────────────────────────────────

/** Per-import counters of what had to change on the way in. */
export interface ConvertStats {
  /** NUL characters removed (PostgreSQL text cannot hold them). */
  nulRemoved: number
  /** Values kept in extra_fields because their column could not hold them. */
  extraValues: number
}

export function newConvertStats(): ConvertStats {
  return { nulRemoved: 0, extraValues: 0 }
}

function clean(s: string, stats: ConvertStats): string {
  if (s.indexOf('\u0000') === -1) return s
  stats.nulRemoved++
  return s.replace(/\u0000/g, '')
}

/** RFC 3339 with at most microseconds, which is what PostgreSQL keeps. */
export function normalizeTimestamp(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(s)
  if (!m) return s
  const frac = m[2] ? m[2].slice(0, 7) : ''
  return `${m[1]}${frac}${m[3]}`
}

function integerText(v: unknown): string | null {
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : '') : String(v ?? '')
  return /^-?\d{1,20}$/.test(s) ? s : null
}

function doubleValue(v: unknown): number | string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity'
  if (v === 'NaN' || v === 'Infinity' || v === '-Infinity') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** A Firestore value as JSON text, exact for integers of any size. */
export function toJsonText(v: FsValue | undefined, root: string, stats: ConvertStats): string {
  const k = kindOf(v)
  switch (k) {
    case 'null': return 'null'
    case 'boolean': return v!.booleanValue ? 'true' : 'false'
    case 'integer': return integerText(v!.integerValue) ?? JSON.stringify(String(v!.integerValue))
    case 'double': {
      const d = doubleValue(v!.doubleValue)
      return typeof d === 'number' ? JSON.stringify(d) : JSON.stringify(d ?? null)
    }
    case 'timestamp': return JSON.stringify(normalizeTimestamp(String(v!.timestampValue)))
    case 'string': return JSON.stringify(clean(String(v!.stringValue), stats))
    case 'bytes': return JSON.stringify(String(v!.bytesValue ?? ''))
    case 'reference': return JSON.stringify(clean(referencePath(String(v!.referenceValue), root), stats))
    case 'geopoint': {
      const g = v!.geoPointValue ?? {}
      return `{"latitude":${JSON.stringify(Number(g.latitude ?? 0))},"longitude":${JSON.stringify(Number(g.longitude ?? 0))}}`
    }
    case 'array': return `[${(v!.arrayValue?.values ?? []).map((x) => toJsonText(x, root, stats)).join(',')}]`
    case 'map': {
      const entries = Object.entries(v!.mapValue?.fields ?? {})
      return `{${entries.map(([key, x]) => `${JSON.stringify(clean(key, stats))}:${toJsonText(x, root, stats)}`).join(',')}}`
    }
    default: return 'null'
  }
}

/** A value for a column of `type`, or `undefined` when it does not fit there. Null fits everywhere. */
export function cellValue(v: FsValue, type: ColumnType, root: string, stats: ConvertStats): unknown {
  const k = kindOf(v)
  if (k === 'null') return null
  switch (type) {
    case 'text':
      if (k === 'string') return clean(String(v.stringValue), stats)
      if (k === 'reference') return clean(referencePath(String(v.referenceValue), root), stats)
      if (k === 'bytes') return String(v.bytesValue ?? '')
      return undefined
    case 'bigint':
      return k === 'integer' ? integerText(v.integerValue) ?? undefined : undefined
    case 'double precision':
      if (k === 'double') return doubleValue(v.doubleValue) ?? undefined
      if (k === 'integer') return integerText(v.integerValue) ?? undefined
      return undefined
    case 'boolean':
      return k === 'boolean' ? !!v.booleanValue : undefined
    case 'timestamptz':
      return k === 'timestamp' ? normalizeTimestamp(String(v.timestampValue)) : undefined
    case 'jsonb':
      return toJsonText(v, root, stats)
    default:
      return undefined
  }
}

/**
 * A row id: a uuid keyed from the document's path with a secret held for this
 * import only (the same construction as lib/import/pg-engine.ts derivedUuid),
 * so a parent's id is known to its children and guessable by nobody.
 */
export function rowIdFor(secret: Buffer, path: string): string {
  const h = createHmac('sha256', secret).update('firestore').update('\u0000').update(path, 'utf8').digest()
  h[6] = (h[6] & 0x0f) | 0x40
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

export interface ConvertedRow {
  values: unknown[]
  /** Fields that had no column, or did not fit theirs, as JSON object text; null when none. */
  extra: string | null
}

/** One document as one row of `plan.insertColumns`. */
export function convertDocument(
  doc: FsDocument,
  loc: DocLocation,
  plan: TablePlan,
  ctx: { namespace: Buffer; root: string; stats: ConvertStats },
): ConvertedRow {
  const fields = doc.fields ?? {}
  const extras: string[] = []
  const used = new Set<string>()

  const values = plan.insertColumns.map((col) => {
    const src = col.source
    switch (src.kind) {
      case 'rowId':
        return rowIdFor(ctx.namespace, loc.path)
      case 'docId':
        return clean(loc.id, ctx.stats)
      case 'parent':
        return loc.parentPath ? rowIdFor(ctx.namespace, loc.parentPath) : null
      case 'createTime':
      case 'updateTime': {
        const meta = src.kind === 'createTime' ? doc.createTime : doc.updateTime
        if (src.field) {
          used.add(src.field)
          const v = fields[src.field]
          if (v && kindOf(v) === 'timestamp') return normalizeTimestamp(String(v.timestampValue))
          if (v && kindOf(v) !== 'null') {
            extras.push(`${JSON.stringify(clean(src.field, ctx.stats))}:${toJsonText(v, ctx.root, ctx.stats)}`)
            ctx.stats.extraValues++
          }
        }
        return meta ? normalizeTimestamp(meta) : null
      }
      case 'field': {
        used.add(src.field)
        const v = fields[src.field]
        if (v === undefined) return null
        const cell = cellValue(v, col.type, ctx.root, ctx.stats)
        if (cell === undefined) {
          extras.push(`${JSON.stringify(clean(src.field, ctx.stats))}:${toJsonText(v, ctx.root, ctx.stats)}`)
          ctx.stats.extraValues++
          return null
        }
        return cell
      }
      default:
        return null
    }
  })

  for (const [field, v] of Object.entries(fields)) {
    if (used.has(field) || plan.fieldColumns.has(field)) continue
    extras.push(`${JSON.stringify(clean(field, ctx.stats))}:${toJsonText(v, ctx.root, ctx.stats)}`)
    ctx.stats.extraValues++
  }

  return { values, extra: extras.length ? `{${extras.join(',')}}` : null }
}
