/**
 * THE SCHEMA SNAPSHOT READS THE WHOLE SCHEMA IN A FIXED NUMBER OF QUERIES
 * =======================================================================
 *
 * Against a real database (lib/services/workspace-schema-snapshot.ts):
 *
 *   the snapshot reads each kind of object once for the whole schema, so the
 *   number of queries does not grow with the project's tables. The database
 *   can be in another region than the process reading it, where every query
 *   is a round trip; read table by table, a change on a project in another
 *   region spent most of its time here;
 *   what it reads is what the table-by-table reader read, on a schema with a
 *   composite primary key, single and multi-column foreign keys, unique,
 *   partial and constraint-owned indexes, row-level security, permissive and
 *   restrictive policies, a user trigger, a table without columns, a quoted
 *   name, and a view and a materialized view, which are not tables.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: 7 }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { captureSchemaSnapshot, type TableSnapshot } from '@/lib/services/workspace-schema-snapshot'

let ownerId: string
let projectId: string
let schema: string
let db: any

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)

/** Raw queries sent on the project's workspace client while `counting` is set. */
let counting: string[] | null = null

async function queriesOf<R>(fn: () => Promise<R>): Promise<{ result: R; queries: string[] }> {
  counting = []
  try {
    const result = await fn()
    return { result, queries: counting }
  } finally {
    counting = null
  }
}

/**
 * The table-by-table reader the snapshot used before, kept here as the
 * reference for what it must read.
 */
async function readTableByTable(postgresSchema: string): Promise<TableSnapshot[]> {
  const tableRows = await db.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    postgresSchema,
  ) as Array<{ table_name: string }>
  const tables: TableSnapshot[] = []
  for (const { table_name } of tableRows) {
    const colRows = await db.$queryRawUnsafe(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      postgresSchema, table_name,
    ) as Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>
    const primaryKeyRows = await db.$queryRawUnsafe(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = $1 AND tc.table_name = $2`,
      postgresSchema, table_name,
    ) as Array<{ column_name: string }>
    const primaryKeys = new Set(primaryKeyRows.map(r => r.column_name))
    const idxRows = await db.$queryRawUnsafe(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2`,
      postgresSchema, table_name,
    ) as Array<{ indexname: string; indexdef: string }>
    const conIdxRows = await db.$queryRawUnsafe(
      `SELECT ci.relname FROM pg_constraint con
       JOIN pg_class ci ON ci.oid = con.conindid
       JOIN pg_class c  ON c.oid  = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      postgresSchema, table_name,
    ) as Array<{ relname: string }>
    const constraintBackedIdx = new Set(conIdxRows.map(r => r.relname))
    const fkRows = await db.$queryRawUnsafe(
      `SELECT
         tc.constraint_name,
         kcu.column_name,
         ccu.table_name AS foreign_table_name,
         ccu.column_name AS foreign_column_name,
         rc.delete_rule
       FROM information_schema.table_constraints AS tc
       JOIN information_schema.key_column_usage AS kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage AS ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       LEFT JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1 AND tc.table_name = $2`,
      postgresSchema, table_name,
    ) as Array<{ constraint_name: string; column_name: string; foreign_table_name: string; foreign_column_name: string; delete_rule: string }>
    const countRows = await db.$queryRawUnsafe(
      `SELECT reltuples::bigint AS reltuples FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      postgresSchema, table_name,
    ) as Array<{ reltuples: bigint | number }>
    const rlsRows = await db.$queryRawUnsafe(
      `SELECT c.relrowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      postgresSchema, table_name,
    ) as Array<{ relrowsecurity: boolean }>
    const polRows = await db.$queryRawUnsafe(
      `SELECT policyname, permissive, roles, cmd, qual, with_check
       FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
      postgresSchema, table_name,
    ) as Array<{ policyname: string; permissive: string; roles: string[] | string; cmd: string; qual: string | null; with_check: string | null }>
    const trgRows = await db.$queryRawUnsafe(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal`,
      postgresSchema, table_name,
    ) as Array<{ tgname: string; def: string }>

    tables.push({
      name: table_name,
      columns: colRows.map(c => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
        isPrimary: primaryKeys.has(c.column_name),
      })),
      indexes: idxRows.map(r => ({
        name: r.indexname,
        // Compared by definition: the column list is derived from it.
        columns: [],
        unique: r.indexdef.includes('UNIQUE'),
        definition: r.indexdef,
        constraintBacked: constraintBackedIdx.has(r.indexname),
      })),
      foreignKeys: fkRows.map(r => ({
        constraintName: r.constraint_name,
        column: r.column_name,
        referencedTable: r.foreign_table_name,
        referencedColumn: r.foreign_column_name,
        onDelete: r.delete_rule ?? 'NO ACTION',
      })),
      rowEstimate: Math.max(0, Number(countRows[0]?.reltuples ?? 0)),
      rlsEnabled: rlsRows[0]?.relrowsecurity === true,
      policies: polRows.map(p => ({
        name: p.policyname,
        cmd: p.cmd ?? 'ALL',
        permissive: String(p.permissive).toUpperCase() !== 'RESTRICTIVE',
        roles: Array.isArray(p.roles) ? p.roles : String(p.roles ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean),
        using: p.qual,
        withCheck: p.with_check,
      })),
      triggers: trgRows.map(t => ({ name: t.tgname, definition: t.def })),
    })
  }
  return tables
}

/**
 * The table-by-table reader read indexes, foreign keys, policies and triggers
 * in no stated order; the snapshot reads them in name order. Compared as sets.
 */
function comparable(tables: TableSnapshot[]) {
  const by = <X>(key: (x: X) => string) => (a: X, b: X) => key(a).localeCompare(key(b))
  return tables.map((t) => ({
    ...t,
    indexes: t.indexes.map(({ columns: _derived, ...i }) => i).sort(by((i) => i.name)),
    foreignKeys: [...t.foreignKeys].sort(by((f) => `${f.constraintName}\u0000${f.column}\u0000${f.referencedColumn}`)),
    policies: [...(t.policies ?? [])].sort(by((p) => p.name)),
    triggers: [...(t.triggers ?? [])].sort(by((x) => x.name)),
  }))
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `snapshot-reader-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'x', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'snapshot-reader', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema

  db = await workspaceRawClient(projectId)
  // As lib/execution/sql-recorder.ts sees them: raw queries arrive with no model.
  db.$use(async (params: any, next: (p: any) => Promise<any>) => {
    if (counting && !params.model && (params.action === 'queryRaw' || params.action === 'executeRaw')) {
      counting.push(String((params.args as unknown[])?.[0] ?? ''))
    }
    return next(params)
  })

  await ddl(`CREATE TABLE ${T('authors')} (id serial PRIMARY KEY, name text NOT NULL, email text UNIQUE, created_at timestamptz DEFAULT now())`)
  await ddl(`CREATE TABLE ${T('books')} (
    id bigserial PRIMARY KEY,
    author_id integer REFERENCES ${T('authors')}(id) ON DELETE CASCADE,
    title text,
    isbn text,
    price numeric(10,2) DEFAULT 0)`)
  await ddl(`CREATE INDEX books_title_idx ON ${T('books')} (title)`)
  await ddl(`CREATE UNIQUE INDEX books_isbn_known ON ${T('books')} (isbn) WHERE isbn IS NOT NULL`)
  await ddl(`ALTER TABLE ${T('books')} ENABLE ROW LEVEL SECURITY`)
  await ddl(`CREATE POLICY books_read ON ${T('books')} FOR SELECT USING (true)`)
  await ddl(`CREATE POLICY books_own ON ${T('books')} AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (author_id IS NOT NULL) WITH CHECK (price >= 0)`)
  await ddl(`CREATE FUNCTION "${schema}".touch_book() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`)
  await ddl(`CREATE TRIGGER books_touch BEFORE UPDATE ON ${T('books')} FOR EACH ROW EXECUTE FUNCTION "${schema}".touch_book()`)
  await ddl(`CREATE TABLE ${T('editions')} (book_id bigint REFERENCES ${T('books')}(id), edition_no integer, printed date, PRIMARY KEY (book_id, edition_no))`)
  await ddl(`CREATE TABLE ${T('reviews')} (
    id serial PRIMARY KEY,
    book_id bigint,
    edition_no integer,
    stars smallint CHECK (stars BETWEEN 1 AND 5),
    FOREIGN KEY (book_id, edition_no) REFERENCES ${T('editions')}(book_id, edition_no) ON DELETE SET NULL)`)
  await ddl(`CREATE TABLE ${T('Quoted Name')} ("Mixed Case" text, plain integer)`)
  await ddl(`CREATE TABLE ${T('no_columns')} ()`)
  await ddl(`CREATE VIEW ${T('author_names')} AS SELECT id, name FROM ${T('authors')}`)
  await ddl(`CREATE MATERIALIZED VIEW ${T('book_counts')} AS SELECT author_id, count(*) AS n FROM ${T('books')} GROUP BY author_id`)
  await ddl(`CREATE INDEX book_counts_author ON ${T('book_counts')} (author_id)`)
  await ddl(`INSERT INTO ${T('authors')} (name) SELECT 'author ' || g FROM generate_series(1, 50) g`)
  await ddl(`ANALYZE ${T('authors')}`)
}, 180_000)

afterAll(async () => {
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('the schema snapshot reader', () => {
  it('reads what the table-by-table reader read', async () => {
    const reference = await readTableByTable(schema)
    const snapshot = await captureSchemaSnapshot(projectId, 'manual')
    expect(snapshot).not.toBeNull()
    const tables = snapshot!.tables

    expect(comparable(tables)).toEqual(comparable(reference))

    // The fixture is read, not only matched: a broken reader agreeing with a
    // broken reference would pass the comparison above.
    const names = tables.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['authors', 'books', 'editions', 'reviews', 'Quoted Name', 'no_columns']))
    expect(names).not.toContain('author_names')
    expect(names).not.toContain('book_counts')
    const table = (name: string) => tables.find((t) => t.name === name)!
    expect(table('authors').columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'created_at'])
    expect(table('authors').rowEstimate).toBe(50)
    expect(table('editions').columns.filter((c) => c.isPrimary).map((c) => c.name)).toEqual(['book_id', 'edition_no'])
    const books = table('books')
    expect(books.rlsEnabled).toBe(true)
    expect(books.policies!.map((p) => [p.name, p.cmd, p.permissive])).toEqual(expect.arrayContaining([['books_own', 'UPDATE', false], ['books_read', 'SELECT', true]]))
    expect(books.triggers!.map((t) => t.name)).toContain('books_touch')
    expect(books.foreignKeys).toEqual([
      expect.objectContaining({ column: 'author_id', referencedTable: 'authors', referencedColumn: 'id', onDelete: 'CASCADE' }),
    ])
    expect(books.indexes.map((i) => [i.name, i.unique, i.constraintBacked])).toEqual([
      ['books_isbn_known', true, false], ['books_pkey', true, true], ['books_title_idx', false, false],
    ])
    expect(table('reviews').foreignKeys.map((f) => f.onDelete)).toContain('SET NULL')
    expect(table('no_columns').columns).toEqual([])
    expect(table('Quoted Name').columns.map((c) => c.name)).toEqual(['Mixed Case', 'plain'])
  })

  it('sends the same number of queries however many tables the project has', async () => {
    const before = await queriesOf(() => captureSchemaSnapshot(projectId, 'manual'))
    expect(before.result).not.toBeNull()
    for (let i = 0; i < 6; i++) await ddl(`CREATE TABLE ${T(`more_${i}`)} (id serial PRIMARY KEY, note text)`)
    const after = await queriesOf(() => captureSchemaSnapshot(projectId, 'manual'))
    expect(after.result!.tables.length).toBe(before.result!.tables.length + 6)

    expect(after.queries.length).toBe(before.queries.length)
    expect(after.queries.length).toBeLessThanOrEqual(9)
  })
})
