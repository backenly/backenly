/**
 * THE IMPORT PLANNER (lib/import/pg-plan.ts)
 * ==========================================
 * What a Supabase or Postgres catalog becomes in a new Backenly project, with
 * no database: exact types where the governed kernel can declare them, the
 * platform's own columns filled from the source's, legacy keys carried and
 * their children rewired to uuids, foreign keys declared parents-first or
 * deferred when rows cannot satisfy them while arriving.
 */

import {
  buildPlan,
  carriedDefault,
  exactSqlType,
  mapColumnType,
  platformSlot,
  safeTableName,
  type CatalogColumn,
  type CatalogForeignKey,
  type CatalogTable,
  type SourceCatalog,
} from '@/lib/import/pg-plan'
import { createTableParams, derivedUuid, rowValues } from '@/lib/import/pg-engine'

function col(name: string, formatted: string, extra: Partial<CatalogColumn> = {}): CatalogColumn {
  return {
    name,
    formatted,
    typeName: formatted,
    typeKind: 'b',
    category: formatted.endsWith('[]') ? 'A' : /timestamp|date/.test(formatted) ? 'D' : 'S',
    elementFormatted: formatted.endsWith('[]') ? formatted.slice(0, -2) : null,
    elementTypeName: null,
    elementKind: null,
    domain: null,
    nullable: true,
    defaultExpr: null,
    identity: false,
    generated: false,
    ...extra,
  }
}

function fk(column: string, refTable: string, extra: Partial<CatalogForeignKey> = {}): CatalogForeignKey {
  return { name: `${column}_fkey`, columns: [column], refSchema: 'public', refTable, refColumns: ['id'], onDelete: 'c', onUpdate: 'a', ...extra }
}

function table(name: string, columns: CatalogColumn[], extra: Partial<CatalogTable> = {}): CatalogTable {
  return {
    schema: 'public',
    name,
    columns,
    primaryKey: ['id'],
    uniques: [],
    foreignKeys: [],
    rlsEnabled: true,
    partitioned: false,
    bytes: 8192,
    rows: 10,
    rowsExact: true,
    ...extra,
  }
}

function catalog(tables: CatalogTable[]): SourceCatalog {
  return { tables, policies: [], functions: 0, triggers: 0, views: 0, materializedViews: 0, extensions: [] }
}

// A typical Supabase project: profiles keyed by the auth user, posts with a
// bigint identity key, comments pointing at both, and a self-referencing tree.
const profiles = table(
  'users',
  [
    col('id', 'uuid'),
    col('username', 'text', { nullable: false }),
    col('created_at', 'timestamp with time zone', { defaultExpr: 'now()' }),
  ],
  { foreignKeys: [fk('id', 'users', { refSchema: 'auth' })], uniques: [['username']] },
)
const posts = table(
  'posts',
  [
    col('id', 'bigint', { identity: true }),
    col('title', 'character varying(200)', { nullable: false }),
    col('author_id', 'uuid'),
    col('tags', 'text[]'),
    col('status', 'public.post_status', { typeKind: 'e', category: 'E', typeName: 'post_status', defaultExpr: "'draft'::post_status" }),
    col('price', 'numeric(10,2)'),
    col('body', 'jsonb'),
    col('embedding', 'vector(3)', { typeName: 'vector', typeKind: 'b', category: 'U' }),
    col('updated_at', 'timestamp with time zone'),
  ],
  { foreignKeys: [fk('author_id', 'users', { onDelete: 'n' })] },
)
const comments = table(
  'comments',
  [col('id', 'bigint'), col('post_id', 'bigint', { nullable: false }), col('user_id', 'uuid'), col('parent_id', 'bigint'), col('body', 'text')],
  {
    foreignKeys: [
      fk('post_id', 'posts'),
      fk('user_id', 'users', { refSchema: 'auth' }),
      fk('parent_id', 'comments', { onDelete: 'c' }),
    ],
  },
)

const plan = buildPlan(catalog([comments, posts, profiles]), { source: 'supabase', usersMoving: true, schemas: ['public'] })
const byName = (n: string) => plan.tables.find((t) => t.name === n)!

describe('names', () => {
  it('a source "users" table arrives as profiles, and says why', () => {
    expect(plan.names['public.users']).toBe('profiles')
    expect(byName('profiles').notes.join(' ')).toMatch(/sign-in owns the users table/)
  })

  it('table names become lower-case identifiers', () => {
    expect(safeTableName('Order Items')).toBe('order_items')
    expect(safeTableName('2fa-codes')).toBe('t_2fa_codes')
  })

  it('a name clash across schemas gives the later schema a prefix', () => {
    const p = buildPlan(
      catalog([table('orders', [col('id', 'uuid')]), table('orders', [col('id', 'uuid')], { schema: 'billing' })]),
      { source: 'postgres', usersMoving: false, schemas: ['public', 'billing'] },
    )
    expect(p.names['public.orders']).toBe('orders')
    expect(p.names['billing.orders']).toBe('billing_orders')
  })
})

describe('order and keys', () => {
  it('parents are created before children', () => {
    const order = plan.tables.map((t) => t.name)
    expect(order.indexOf('profiles')).toBeLessThan(order.indexOf('posts'))
    expect(order.indexOf('posts')).toBeLessThan(order.indexOf('comments'))
  })

  it('a key to a uuid parent is declared with the table, actions as written', () => {
    const author = byName('posts').columns.find((c) => c.name === 'author_id')!
    expect(author.references).toEqual({ table: 'profiles', column: 'id', onDelete: 'SET NULL', onUpdate: 'NO ACTION' })
  })

  it('a bigint key is carried in legacy_id and the row id is derived from it', () => {
    const p = byName('posts')
    expect(p.pk.kind).toBe('carried')
    expect(p.pk.carrier).toBe('legacy_id')
    const carrier = p.columns.find((c) => c.name === 'legacy_id')!
    expect(carrier).toMatchObject({ sqlType: 'bigint', notNull: true, unique: true })
    const id = p.copy.find((c) => c.column === 'id')!
    expect(id.derive).toEqual({ table: 'posts' })
  })

  it('a child of a legacy-keyed parent gets a uuid to its new id and keeps the old value', () => {
    const c = byName('comments')
    expect(c.columns.find((x) => x.name === 'post_id_legacy')).toMatchObject({ sqlType: 'bigint' })
    const postId = c.columns.find((x) => x.name === 'post_id')!
    expect(postId).toMatchObject({ sqlType: 'uuid', references: { table: 'posts', column: 'id', onDelete: 'CASCADE' } })
    expect(c.copy.find((x) => x.column === 'post_id')!.derive).toEqual({ table: 'posts' })
  })

  it('a self reference is added after the rows, not declared with the table', () => {
    const c = byName('comments')
    expect(c.columns.find((x) => x.name === 'parent_id')!.references).toBeUndefined()
    expect(c.deferredForeignKeys).toContainEqual(expect.objectContaining({ column: 'parent_id', why: 'self', references: expect.objectContaining({ table: 'comments' }) }))
  })

  it("keys into Supabase's auth.users become keys into users when users move", () => {
    const c = byName('comments')
    expect(c.deferredForeignKeys).toContainEqual(expect.objectContaining({ column: 'user_id', why: 'users', references: expect.objectContaining({ table: 'users', column: 'id' }) }))
    // profiles.id → auth.users.id: a key on the platform id itself.
    expect(byName('profiles').deferredForeignKeys).toContainEqual(expect.objectContaining({ column: 'id', why: 'users' }))
  })

  it('and stay plain values when users do not move', () => {
    const p = buildPlan(catalog([comments, posts, profiles]), { source: 'supabase', usersMoving: false, schemas: ['public'] })
    const c = p.tables.find((t) => t.name === 'comments')!
    expect(c.deferredForeignKeys.some((d) => d.why === 'users')).toBe(false)
    expect(c.notes.join(' ')).toMatch(/auth users; the values are kept/)
  })

  it('a cycle defers its keys and is said', () => {
    const a = table('a', [col('id', 'uuid'), col('b_id', 'uuid')], { foreignKeys: [fk('b_id', 'b')] })
    const b = table('b', [col('id', 'uuid'), col('a_id', 'uuid')], { foreignKeys: [fk('a_id', 'a')] })
    const p = buildPlan(catalog([a, b]), { source: 'postgres', usersMoving: false, schemas: ['public'] })
    expect(p.tables).toHaveLength(2)
    for (const t of p.tables) {
      expect(t.columns.every((c) => !c.references)).toBe(true)
      expect(t.deferredForeignKeys[0]?.why).toBe('cycle')
    }
    expect(p.warnings.join(' ')).toMatch(/cycle/)
  })

  it('a key to a unique column follows that column under its arriving name', () => {
    const customers = table('customers', [col('id', 'uuid'), col('email', 'text')], { uniques: [['email']] })
    const orders = table('orders', [col('id', 'uuid'), col('customer_email', 'text')], {
      foreignKeys: [fk('customer_email', 'customers', { refColumns: ['email'] })],
    })
    const p = buildPlan(catalog([orders, customers]), { source: 'postgres', usersMoving: false, schemas: ['public'] })
    const ref = p.tables.find((t) => t.name === 'orders')!.columns.find((c) => c.name === 'customer_email')!.references
    expect(ref).toMatchObject({ table: 'customers', column: 'email' })
  })
})

describe('columns', () => {
  it('created_at and updated_at fill the platform columns', () => {
    expect(byName('profiles').copy.find((c) => c.column === 'createdAt')).toBeTruthy()
    expect(byName('posts').copy.find((c) => c.column === 'updatedAt')).toBeTruthy()
    // never declared as columns of their own
    expect(byName('posts').columns.some((c) => /updated/i.test(c.name))).toBe(false)
  })

  it('types are kept exactly where the kernel can declare them', () => {
    const p = byName('posts')
    const t = (n: string) => p.columns.find((c) => c.name === n)!
    expect(t('title').sqlType).toBe('varchar(200)')
    expect(t('tags').sqlType).toBe('text[]')
    expect(t('price').sqlType).toBe('numeric(10,2)')
    expect(t('body').sqlType).toBe('jsonb')
  })

  it('enums and pgvector are stored as text and said', () => {
    const p = byName('posts')
    expect(p.columns.find((c) => c.name === 'status')!.sqlType).toBe('text')
    expect(p.notes.join(' ')).toMatch(/enum post_status stored as text/)
    expect(p.notes.join(' ')).toMatch(/pgvector/)
  })

  it("an enum default loses its cast; a sequence's is not carried and the column is not forced", () => {
    expect(byName('posts').columns.find((c) => c.name === 'status')!.default).toBe("'draft'")
    expect(carriedDefault("nextval('posts_id_seq'::regclass)")).toEqual({})
    expect(carriedDefault("timezone('utc'::text, now())")).toEqual({ dropped: "timezone('utc'::text, now())" })
    expect(carriedDefault("'{}'::jsonb")).toEqual({ value: "'{}'::jsonb" })
  })

  it('NOT NULL and single-column UNIQUE are carried', () => {
    expect(byName('profiles').columns.find((c) => c.name === 'username')).toMatchObject({ notNull: true, unique: true })
  })

  it('names the executor would merge (user_id / userId) are told apart', () => {
    const p = buildPlan(catalog([table('t', [col('id', 'uuid'), col('user_id', 'text'), col('userId', 'text')])]), {
      source: 'postgres',
      usersMoving: false,
      schemas: ['public'],
    })
    const names = p.tables[0].columns.map((c) => c.name)
    expect(names).toHaveLength(2)
    expect(new Set(names.map((n) => n.toLowerCase().replace(/_/g, ''))).size).toBe(2)
  })

  it('exact spellings', () => {
    expect(exactSqlType('timestamp(3) with time zone')).toBe('timestamptz(3)')
    expect(exactSqlType('character(2)')).toBe('char(2)')
    expect(exactSqlType('citext')).toBe('text')
    expect(exactSqlType('inet')).toBeNull()
    expect(mapColumnType(col('ip', 'inet')).sqlType).toBe('text')
    expect(mapColumnType(col('blob', 'bytea')).type).toBe('BYTEA')
    expect(mapColumnType(col('cost', 'money')).expr).toBe('%s::numeric::text')
    expect(platformSlot('Created_At')).toBe('createdAt')
  })
})

describe('the executor call and the rows', () => {
  it('every table is created as written', () => {
    const params = createTableParams(byName('posts'))
    expect(params.asWritten).toBe(true)
    expect(params.tableName).toBe('posts')
  })

  it('a derived id is the same for the row and for every row pointing at it, and not guessable without the secret', () => {
    const secret = Buffer.alloc(32, 7)
    const other = Buffer.alloc(32, 8)
    expect(derivedUuid(secret, 'posts', '42')).toBe(derivedUuid(secret, 'posts', '42'))
    expect(derivedUuid(secret, 'posts', '42')).not.toBe(derivedUuid(other, 'posts', '42'))
    expect(derivedUuid(secret, 'posts', '42')).not.toBe(derivedUuid(secret, 'comments', '42'))
    expect(derivedUuid(secret, 'posts', '42')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    const p = byName('posts')
    const c = byName('comments')
    const postRow: unknown[] = p.select.map(() => null)
    postRow[p.copy.find((x) => x.column === 'legacy_id')!.from] = '42'
    const postValues = rowValues(p, postRow, secret)
    const commentRow: unknown[] = c.select.map(() => null)
    commentRow[c.copy.find((x) => x.column === 'post_id_legacy')!.from] = '42'
    const commentValues = rowValues(c, commentRow, secret)
    expect(commentValues[c.copy.findIndex((x) => x.column === 'post_id')]).toBe(postValues[p.copy.findIndex((x) => x.column === 'id')])
  })
})

describe('what does not move', () => {
  it('views, functions and triggers are counted and said; internal tables are skipped', () => {
    const p = buildPlan(
      { ...catalog([table('schema_migrations', [col('version', 'text')])]), views: 2, functions: 3, triggers: 1 },
      { source: 'supabase', usersMoving: false, schemas: ['public'] },
    )
    expect(p.tables).toHaveLength(0)
    const w = p.warnings.join(' ')
    expect(w).toMatch(/2 views not moved/)
    expect(w).toMatch(/3 database functions not moved/)
    expect(w).toMatch(/1 trigger not moved/)
    expect(w).toMatch(/Skipped "schema_migrations"/)
  })
})
