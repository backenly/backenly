/**
 * Firestore → Backenly tables, the pure half (lib/import/drivers/firebase-schema.ts):
 * column types inferred from documents, table and column names, and each
 * document converted to a row. Fixtures are documents exactly as Firestore's
 * REST API returns them (integers as strings, nanosecond timestamps, full
 * resource names in references). Database-free.
 */

import {
  CollectionProfile,
  TableNames,
  columnNamePart,
  convertDocument,
  inferColumnType,
  locate,
  newConvertStats,
  normalizeTimestamp,
  planTable,
  rowIdFor,
  tableNamePart,
  toJsonText,
  writeColumns,
  writeRow,
  MAX_FIELD_COLUMNS,
  type FsDocument,
} from '@/lib/import/drivers/firebase-schema'
import { buildInserts, createTableParams } from '@/lib/import/drivers/firebase-destination'

const ROOT = 'projects/demo-shop/databases/(default)/documents'

/** A page of `posts` as GET …/documents/posts returns it. */
const POSTS_PAGE: { documents: FsDocument[]; nextPageToken: string } = {
  documents: [
    {
      name: `${ROOT}/posts/0A1b2C3d4E5f6G7h8I9j`,
      fields: {
        title: { stringValue: 'Hello\u0000world' },
        likes: { integerValue: '42' },
        rating: { doubleValue: 4.5 },
        published: { booleanValue: true },
        createdAt: { timestampValue: '2024-03-01T10:15:30.123456789Z' },
        tags: { arrayValue: { values: [{ stringValue: 'news' }, { integerValue: '9007199254740993' }] } },
        author: { referenceValue: `${ROOT}/users/uid_1` },
        location: { geoPointValue: { latitude: 52.52, longitude: 13.405 } },
        meta: { mapValue: { fields: { views: { integerValue: '7' }, flags: { mapValue: {} } } } },
        note: { nullValue: null },
        price: { integerValue: '10' },
        avatar: { bytesValue: 'iVBORw0KGgo=' },
        'first name': { stringValue: 'Ada' },
        id: { stringValue: 'legacy-17' },
        mixed: { stringValue: 'seven' },
      },
      createTime: '2024-03-01T10:15:30.123456789Z',
      updateTime: '2024-03-02T08:00:00.000001Z',
    },
    {
      name: `${ROOT}/posts/Zz9`,
      fields: {
        title: { stringValue: 'Second' },
        likes: { integerValue: '-3' },
        rating: { doubleValue: 'NaN' },
        published: { booleanValue: false },
        tags: { arrayValue: {} },
        note: { nullValue: null },
        price: { doubleValue: 9.99 },
        mixed: { integerValue: '7' },
      },
      createTime: '2024-04-01T00:00:00Z',
      updateTime: '2024-04-01T00:00:00Z',
    },
  ],
  nextPageToken: 'AFTOeJwOhnDl2sMR',
}

function profileOf(docs: FsDocument[]): CollectionProfile {
  const p = new CollectionProfile()
  for (const d of docs) p.add(d)
  return p
}

describe('column types', () => {
  it('maps each Firestore kind as the spec says', () => {
    expect(inferColumnType(['string'])).toEqual({ type: 'text', mixed: false })
    expect(inferColumnType(['integer'])).toEqual({ type: 'bigint', mixed: false })
    expect(inferColumnType(['double'])).toEqual({ type: 'double precision', mixed: false })
    expect(inferColumnType(['boolean'])).toEqual({ type: 'boolean', mixed: false })
    expect(inferColumnType(['timestamp'])).toEqual({ type: 'timestamptz', mixed: false })
    expect(inferColumnType(['map'])).toEqual({ type: 'jsonb', mixed: false })
    expect(inferColumnType(['array'])).toEqual({ type: 'jsonb', mixed: false })
    expect(inferColumnType(['geopoint'])).toEqual({ type: 'jsonb', mixed: false })
    expect(inferColumnType(['reference'])).toEqual({ type: 'text', mixed: false })
    expect(inferColumnType(['bytes'])).toEqual({ type: 'text', mixed: false })
  })

  it('ignores nulls, stores null-only and mixed fields as jsonb, and widens integers mixed with doubles', () => {
    expect(inferColumnType(['null', 'string', 'null'])).toEqual({ type: 'text', mixed: false })
    expect(inferColumnType(['null'])).toEqual({ type: 'jsonb', mixed: false })
    expect(inferColumnType(['string', 'integer'])).toEqual({ type: 'jsonb', mixed: true })
    expect(inferColumnType(['timestamp', 'string'])).toEqual({ type: 'jsonb', mixed: true })
    expect(inferColumnType(['map', 'array'])).toEqual({ type: 'jsonb', mixed: false })
    // JavaScript clients write 10 as an integer and 9.99 as a double.
    expect(inferColumnType(['integer', 'double'])).toEqual({ type: 'double precision', mixed: false })
  })

  it('plans a table from a recorded page of documents', () => {
    const plan = planTable({ pattern: 'posts', name: 'posts', parentTable: null, profile: profileOf(POSTS_PAGE.documents), total: 2 })
    const byField = Object.fromEntries([...plan.fieldColumns.entries()].map(([f, c]) => [f, `${c.name}:${c.type}`]))
    expect(byField).toEqual({
      'first name': 'first_name:text',
      author: 'author:text',
      avatar: 'avatar:text',
      id: 'id_firebase:text',
      likes: 'likes:bigint',
      location: 'location:jsonb',
      meta: 'meta:jsonb',
      mixed: 'mixed:jsonb',
      note: 'note:jsonb',
      price: 'price:double precision',
      published: 'published:boolean',
      rating: 'rating:double precision',
      tags: 'tags:jsonb',
      title: 'title:text',
    })
    // createdAt is a timestamp: it fills Backenly's own createdAt instead of a column of its own.
    expect(plan.fieldColumns.has('createdAt')).toBe(false)
    expect(plan.insertColumns.slice(0, 4).map((c) => c.name)).toEqual(['id', 'createdAt', 'updatedAt', 'firebase_id'])
    expect(plan.createColumns[0]).toMatchObject({ name: 'firebase_id', type: 'text', unique: true })
    expect(plan.extraColumn).toBe(false)
    expect(plan.notes).toEqual(expect.arrayContaining([
      'Document ids are in firebase_id.',
      '"createdAt" fills Backenly\'s own createdAt.',
      '"mixed" holds more than one kind of value, so it is stored as JSON.',
      '"note" is empty in every document read, so stored as JSON.',
      '"avatar" holds binary data, stored as base64 text.',
    ]))
    expect(plan.notes.find((n) => n.startsWith('Renamed to fit SQL'))).toMatch(/"first name" → first_name.*"id" → id_firebase/)
  })

  it('says when types came from part of the collection, and keeps later fields in extra_fields', () => {
    const plan = planTable({ pattern: 'posts', name: 'posts', parentTable: null, profile: profileOf(POSTS_PAGE.documents), total: 52_000 })
    expect(plan.notes).toContain('Column types come from 2 of 52,000 documents; a field first seen later goes into extra_fields.')
  })

  it('keeps the most used fields as columns and the rest together, past the column limit', () => {
    const fields: Record<string, any> = {}
    for (let i = 0; i < MAX_FIELD_COLUMNS + 5; i++) fields[`f${String(i).padStart(3, '0')}`] = { stringValue: 'x' }
    const plan = planTable({ pattern: 'wide', name: 'wide', parentTable: null, profile: profileOf([{ name: `${ROOT}/wide/a`, fields }]), total: 1 })
    expect(plan.fieldColumns.size).toBe(MAX_FIELD_COLUMNS)
    expect(plan.extraColumn).toBe(true)
    expect(writeColumns(plan).at(-1)!.name).toBe('extra_fields')
    expect(plan.notes).toContain('5 rarely used fields are kept together in extra_fields.')
  })
})

describe('names', () => {
  it('turns collection ids into safe table names', () => {
    expect(tableNamePart('posts')).toBe('posts')
    expect(tableNamePart('userProfiles')).toBe('user_profiles')
    expect(tableNamePart('HTTPRequests')).toBe('http_requests')
    expect(tableNamePart('order-items 2024')).toBe('order_items_2024')
    expect(tableNamePart('2024_logs')).toBe('c_2024_logs')
    expect(tableNamePart('Café')).toBe('cafe')
    expect(tableNamePart('日本')).toBe('collection')
  })

  it('names subcollections {parent}_{child}, users as profiles, and never twice', () => {
    const names = new TableNames()
    names.assignAll(['posts/*/comments', 'users', 'users/*/orders', 'posts', 'posts/*/comments/*/likes', 'userProfiles', 'user_profiles'])
    expect(names.nameFor('posts')).toBe('posts')
    expect(names.nameFor('posts/*/comments')).toBe('posts_comments')
    expect(names.nameFor('posts/*/comments/*/likes')).toBe('posts_comments_likes')
    expect(names.nameFor('users')).toBe('profiles')
    expect(names.nameFor('users/*/orders')).toBe('profiles_orders')
    // Two collections that read the same in SQL: the second gets a number.
    expect(names.nameFor('userProfiles')).toBe('user_profiles')
    expect(names.nameFor('user_profiles')).toBe('user_profiles_2')
    expect(TableNames.renameNote('users', 'profiles')).toBe("users is Backenly's sign-in table, so these documents arrive in profiles.")
  })

  it('keeps long names within 63 characters and still unique', () => {
    const names = new TableNames()
    const a = names.nameFor(`${'a'.repeat(40)}/*/${'b'.repeat(40)}`)
    const b = names.nameFor(`${'a'.repeat(40)}/*/${'b'.repeat(39)}c`)
    expect(a.length).toBeLessThanOrEqual(63)
    expect(b.length).toBeLessThanOrEqual(63)
    expect(a).not.toBe(b)
  })

  it('turns field names into safe column names, keeping their case', () => {
    expect(columnNamePart('displayName')).toBe('displayName')
    expect(columnNamePart('first name')).toBe('first_name')
    expect(columnNamePart('price.usd')).toBe('price_usd')
    expect(columnNamePart('1st')).toBe('f_1st')
    expect(columnNamePart('__meta__')).toBe('meta')
    expect(columnNamePart('名前')).toBe('field')
  })

  it('gives fields that differ only by case or underscores their own columns', () => {
    const doc: FsDocument = { name: `${ROOT}/t/a`, fields: { userName: { stringValue: 'a' }, username: { stringValue: 'b' }, user_name: { stringValue: 'c' } } }
    const plan = planTable({ pattern: 't', name: 't', parentTable: null, profile: profileOf([doc]), total: 1 })
    const cols = [...plan.fieldColumns.values()].map((c) => c.name)
    expect(new Set(cols.map((c) => c.toLowerCase().replace(/_/g, ''))).size).toBe(3)
  })

  it('locates documents and their parents from resource names', () => {
    expect(locate(`${ROOT}/posts/a/comments/c`, ROOT)).toEqual({
      path: 'posts/a/comments/c',
      id: 'c',
      parentPath: 'posts/a',
      collections: ['posts', 'comments'],
      pattern: 'posts/*/comments',
    })
    expect(locate(`${ROOT}/posts/a`, ROOT)!.parentPath).toBeNull()
    expect(locate(`${ROOT}/posts`, ROOT)).toBeNull()
    expect(locate('projects/other/databases/(default)/documents/posts/a', ROOT)).toBeNull()
  })
})

describe('rows', () => {
  const secret = Buffer.alloc(32, 7)

  it('converts every kind of value, exactly', () => {
    const plan = planTable({ pattern: 'posts', name: 'posts', parentTable: null, profile: profileOf(POSTS_PAGE.documents), total: 2 })
    const stats = newConvertStats()
    const doc = POSTS_PAGE.documents[0]
    const row = convertDocument(doc, locate(doc.name, ROOT)!, plan, { namespace: secret, root: ROOT, stats })
    const v = Object.fromEntries(plan.insertColumns.map((c, i) => [c.name, row.values[i]]))
    expect(v.id).toBe(rowIdFor(secret, 'posts/0A1b2C3d4E5f6G7h8I9j'))
    expect(v.createdAt).toBe('2024-03-01T10:15:30.123456Z') // the field, to the microsecond PostgreSQL keeps
    expect(v.updatedAt).toBe('2024-03-02T08:00:00.000001Z') // the document's updateTime
    expect(v.firebase_id).toBe('0A1b2C3d4E5f6G7h8I9j')
    expect(v.title).toBe('Helloworld') // NUL removed: PostgreSQL text cannot hold it
    expect(stats.nulRemoved).toBe(1)
    expect(v.likes).toBe('42')
    expect(v.rating).toBe(4.5)
    expect(v.published).toBe(true)
    expect(v.price).toBe('10') // an integer in a double precision column
    expect(v.author).toBe('users/uid_1')
    expect(v.avatar).toBe('iVBORw0KGgo=')
    expect(v.first_name).toBe('Ada')
    expect(v.id_firebase).toBe('legacy-17')
    expect(v.note).toBeNull() // a Firestore null is SQL NULL, in any column
    expect(v.mixed).toBe('"seven"')
    // Integers past 2^53 stay exact inside JSON.
    expect(v.tags).toBe('["news",9007199254740993]')
    expect(v.location).toBe('{"latitude":52.52,"longitude":13.405}')
    expect(v.meta).toBe('{"views":7,"flags":{}}')
    expect(row.extra).toBeNull()

    const second = POSTS_PAGE.documents[1]
    const r2 = convertDocument(second, locate(second.name, ROOT)!, plan, { namespace: secret, root: ROOT, stats })
    const v2 = Object.fromEntries(plan.insertColumns.map((c, i) => [c.name, r2.values[i]]))
    expect(v2.rating).toBe('NaN')
    expect(v2.price).toBe(9.99)
    expect(v2.createdAt).toBe('2024-04-01T00:00:00Z') // no createdAt field: the document's createTime
    expect(v2.tags).toBe('[]')
    expect(v2.mixed).toBe('7')
    expect(v2.author).toBeNull()
  })

  it('links a subcollection row to its parent row without a lookup', () => {
    const comment: FsDocument = {
      name: `${ROOT}/posts/0A1b2C3d4E5f6G7h8I9j/comments/c1`,
      fields: { body: { stringValue: 'Nice' } },
      createTime: '2024-03-03T00:00:00Z',
      updateTime: '2024-03-03T00:00:00Z',
    }
    const plan = planTable({ pattern: 'posts/*/comments', name: 'posts_comments', parentTable: 'posts', profile: profileOf([comment]), total: 1 })
    expect(plan.createColumns.map((c) => c.name)).toEqual(['firebase_id', 'parent_id', 'body'])
    expect(plan.createColumns[0].unique).toBeUndefined() // ids repeat from parent to parent
    const row = convertDocument(comment, locate(comment.name, ROOT)!, plan, { namespace: secret, root: ROOT, stats: newConvertStats() })
    const v = Object.fromEntries(plan.insertColumns.map((c, i) => [c.name, row.values[i]]))
    expect(v.parent_id).toBe(rowIdFor(secret, 'posts/0A1b2C3d4E5f6G7h8I9j'))
    expect(v.id).toBe(rowIdFor(secret, 'posts/0A1b2C3d4E5f6G7h8I9j/comments/c1'))
    expect(plan.notes[0]).toBe('Document ids are in firebase_id; parent_id is the id of the posts row each one belongs to.')
  })

  it('keeps a field the sample never saw, and a value of another type, in extra_fields', () => {
    const plan = planTable({ pattern: 'posts', name: 'posts', parentTable: null, profile: profileOf(POSTS_PAGE.documents), total: 3 })
    const later: FsDocument = {
      name: `${ROOT}/posts/later`,
      fields: { likes: { stringValue: 'many' }, subtitle: { stringValue: 'new field' }, createdAt: { stringValue: 'yesterday' } },
      createTime: '2024-05-01T00:00:00Z',
    }
    const stats = newConvertStats()
    const row = convertDocument(later, locate(later.name, ROOT)!, plan, { namespace: secret, root: ROOT, stats })
    const v = Object.fromEntries(plan.insertColumns.map((c, i) => [c.name, row.values[i]]))
    expect(v.likes).toBeNull()
    expect(v.createdAt).toBe('2024-05-01T00:00:00Z')
    expect(JSON.parse(row.extra!)).toEqual({ likes: 'many', subtitle: 'new field', createdAt: 'yesterday' })
    expect(stats.extraValues).toBe(3)
    // Written with extra_fields once the table has it.
    plan.extraColumn = true
    expect(writeColumns(plan).map((c) => c.name).at(-1)).toBe('extra_fields')
    expect(writeRow(plan, row).at(-1)).toBe(row.extra)
  })

  it('derives ids that are uuids, stable for a path, different for another secret', () => {
    const a = rowIdFor(secret, 'posts/a')
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(rowIdFor(secret, 'posts/a')).toBe(a)
    expect(rowIdFor(secret, 'posts/b')).not.toBe(a)
    expect(rowIdFor(Buffer.alloc(32, 8), 'posts/a')).not.toBe(a)
  })

  it('is written with one cast per column, createdAt falling back to now(), under the parameter limit', () => {
    const plan = planTable({ pattern: 'posts', name: 'posts', parentTable: null, profile: profileOf(POSTS_PAGE.documents), total: 2 })
    const stats = newConvertStats()
    const rows = POSTS_PAGE.documents.map((d) => writeRow(plan, convertDocument(d, locate(d.name, ROOT)!, plan, { namespace: secret, root: ROOT, stats })))
    // A real workspace schema: `workspace_` and the project's uuid, hyphens included.
    const ws = 'workspace_d56a7f06-4705-41d3-86a0-bff423c15e37'
    const [stmt] = buildInserts(ws, 'posts', writeColumns(plan), rows)
    expect(stmt.sql.startsWith(`INSERT INTO "${ws}"."posts" ("id", "createdAt", "updatedAt", "firebase_id", `)).toBe(true)
    expect(stmt.sql).toContain('($1::uuid, COALESCE($2::timestamptz, now()), COALESCE($3::timestamptz, now()), $4::text, ')
    expect(stmt.sql).toMatch(/::double precision/)
    expect(stmt.sql).toMatch(/::jsonb/)
    expect(stmt.sql.endsWith(' ON CONFLICT DO NOTHING')).toBe(true)
    expect(stmt.values).toHaveLength(rows.length * writeColumns(plan).length)
    // Values travel as parameters, never inside the SQL.
    expect(stmt.sql).not.toContain('legacy-17')

    const wide = Array.from({ length: 2000 }, () => rows[0])
    const split = buildInserts(ws, 'posts', writeColumns(plan), wide)
    expect(split.length).toBeGreaterThan(1)
    expect(split.every((s) => s.values.length <= 30_000)).toBe(true)
    expect(split.reduce((n, s) => n + s.values.length, 0)).toBe(2000 * writeColumns(plan).length)
    expect(() => buildInserts(ws, 'posts"; DROP TABLE x; --', writeColumns(plan), rows)).toThrow(/unsafe SQL name/)
    expect(() => buildInserts('public', 'posts', writeColumns(plan), rows)).toThrow(/unsafe schema name/)
  })

  it('creates each table exactly as declared, so no column name is guessed into a key', () => {
    const doc: FsDocument = { name: `${ROOT}/orders/o1`, fields: { user_id: { stringValue: 'firebase-uid-1' }, status: { stringValue: 'paid' }, total: { doubleValue: 9.5 } } }
    const plan = planTable({ pattern: 'orders', name: 'orders', parentTable: null, profile: profileOf([doc]), total: 1 })
    expect(createTableParams(plan)).toEqual({
      tableName: 'orders',
      asWritten: true,
      // No buckets or columns guessed from the name (see the executor's noAutoProvision).
      noAutoProvision: true,
      columns: [
        { name: 'firebase_id', type: 'TEXT', sqlType: 'text', unique: true },
        { name: 'status', type: 'TEXT', sqlType: 'text' },
        { name: 'total', type: 'DOUBLE PRECISION', sqlType: 'double precision' },
        // A Firebase uid is text: sqlType keeps the table builder from making `*_id` a uuid key.
        { name: 'user_id', type: 'TEXT', sqlType: 'text' },
      ],
    })
  })

  it('writes JSON PostgreSQL accepts', () => {
    const stats = newConvertStats()
    expect(toJsonText({ doubleValue: 'Infinity' }, ROOT, stats)).toBe('"Infinity"')
    expect(toJsonText({ mapValue: { fields: { 'a\u0000b': { stringValue: 'x\u0000' } } } }, ROOT, stats)).toBe('{"ab":"x"}')
    expect(toJsonText({ timestampValue: '2024-01-01T00:00:00.999999999Z' }, ROOT, stats)).toBe('"2024-01-01T00:00:00.999999Z"')
    expect(normalizeTimestamp('2024-01-01T00:00:00Z')).toBe('2024-01-01T00:00:00Z')
    expect(normalizeTimestamp('2024-01-01T00:00:00.1+05:30')).toBe('2024-01-01T00:00:00.1+05:30')
  })
})
