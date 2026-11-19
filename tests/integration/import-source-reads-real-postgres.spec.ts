/**
 * A source is read through the importer's own connection (lib/import/net.ts
 * connectSource: the address check, the guard on what the source sends,
 * readSnapshot's read-only transaction), here against a real PostgreSQL.
 *
 *   - A partitioned table holds nothing itself, so pg_table_size says 0 for
 *     it; it is measured by its partitions, sub-partitions and partitions in
 *     another schema included, for the preview, the first batch's size and
 *     the plan's limit (lib/import/pg-source.ts).
 *   - The guard passes everything a real server says while the catalog is
 *     read and rows are fetched through a cursor, and stops a row a real
 *     server sends at more than 64 MB, saying so (lib/import/source-guard.ts).
 *
 * Real PostgreSQL (the test database), real pg client, nothing mocked.
 */

import crypto from 'crypto'
import { Client } from 'pg'
import { connectSource, parsePostgresUrl, readSnapshot, type SourceConnection } from '@/lib/import/net'
import { readCatalog, schemaBytes } from '@/lib/import/pg-source'
import { SourceWireError } from '@/lib/import/source-guard'

const suffix = crypto.randomBytes(4).toString('hex')
const SCHEMA = `bkn_src_${suffix}`
const ELSEWHERE = `bkn_src_other_${suffix}`
const ENV = 'BACKENLY_IMPORT_EGRESS_ALLOW_PRIVATE'
const saved = process.env[ENV]

let admin: Client
let conn: SourceConnection | null = null

async function bytesOf(sql: string): Promise<number> {
  const r = await admin.query<{ b: string }>(sql)
  return Number(r.rows[0]?.b ?? 0)
}

beforeAll(async () => {
  admin = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`)
  await admin.query(`CREATE SCHEMA "${ELSEWHERE}"`)
  // Autovacuum off on the tables that hold rows, so no free-space map appears between two measurements.
  const still = 'WITH (autovacuum_enabled = false)'
  await admin.query(`CREATE TABLE "${SCHEMA}".events (id bigint NOT NULL, at date NOT NULL, payload text) PARTITION BY RANGE (at)`)
  await admin.query(`CREATE TABLE "${SCHEMA}".events_2025 PARTITION OF "${SCHEMA}".events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01') ${still}`)
  // A partition that is itself partitioned, and one of its partitions in another schema.
  await admin.query(`CREATE TABLE "${SCHEMA}".events_2026 PARTITION OF "${SCHEMA}".events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01') PARTITION BY RANGE (at)`)
  await admin.query(`CREATE TABLE "${SCHEMA}".events_2026_h1 PARTITION OF "${SCHEMA}".events_2026 FOR VALUES FROM ('2026-01-01') TO ('2026-07-01') ${still}`)
  await admin.query(`CREATE TABLE "${ELSEWHERE}".events_2026_h2 PARTITION OF "${SCHEMA}".events_2026 FOR VALUES FROM ('2026-07-01') TO ('2027-01-01') ${still}`)
  await admin.query(
    `INSERT INTO "${SCHEMA}".events (id, at, payload)
     SELECT g, date '2025-01-01' + (g % 700), repeat(md5(g::text), 20) FROM generate_series(1, 3000) g`,
  )
  await admin.query(`CREATE TABLE "${SCHEMA}".notes (id bigint PRIMARY KEY, body text) ${still}`)
  await admin.query(`INSERT INTO "${SCHEMA}".notes SELECT g, repeat('n', 200) FROM generate_series(1, 500) g`)
  process.env[ENV] = 'true'
}, 60_000)

afterAll(async () => {
  await conn?.end()
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
  await admin.query(`DROP SCHEMA IF EXISTS "${ELSEWHERE}" CASCADE`).catch(() => {})
  await admin.end()
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
})

async function open(): Promise<SourceConnection> {
  await conn?.end()
  conn = await connectSource(parsePostgresUrl(process.env.TEST_DATABASE_URL!), { requireTls: false, secrets: [] })
  return conn
}

it('measures a partitioned table by its partitions, wherever they live, and each table once', async () => {
  const partitions = await bytesOf(
    `SELECT sum(pg_table_size(c.oid))::bigint AS b FROM pg_class c
      WHERE c.oid IN ('"${SCHEMA}".events_2025'::regclass, '"${SCHEMA}".events_2026_h1'::regclass, '"${ELSEWHERE}".events_2026_h2'::regclass)`,
  )
  const notes = await bytesOf(`SELECT pg_table_size('"${SCHEMA}".notes'::regclass)::bigint AS b`)
  expect(await bytesOf(`SELECT pg_table_size('"${SCHEMA}".events'::regclass)::bigint AS b`)).toBe(0)
  expect(partitions).toBeGreaterThan(100_000)

  const source = await open()
  const { catalog, total } = await readSnapshot(source, async (db) => ({
    catalog: await readCatalog(db, [SCHEMA]),
    total: await schemaBytes(db, [SCHEMA]),
  }))
  // Only the tables a person would move: the partitions arrive inside their table.
  expect(catalog.tables.map((t) => t.name).sort()).toEqual(['events', 'notes'])
  const events = catalog.tables.find((t) => t.name === 'events')!
  expect(events.partitioned).toBe(true)
  expect(events.bytes).toBe(partitions)
  expect(catalog.tables.find((t) => t.name === 'notes')!.bytes).toBe(notes)
  expect(total).toBe(partitions + notes)
})

it('reads the catalog and every row through a cursor, all of it passing the guard', async () => {
  const source = await open()
  const fetched = await readSnapshot(source, async (db) => {
    await db.query(`DECLARE bkn_import_0 NO SCROLL CURSOR FOR SELECT id::text, at::text, payload FROM "${SCHEMA}".events`)
    let n = 0
    for (;;) {
      const { rows } = await db.queryArrays('FETCH FORWARD 700 FROM bkn_import_0')
      if (rows.length === 0) break
      n += rows.length
    }
    await db.query('CLOSE bkn_import_0')
    return n
  })
  expect(fetched).toBe(3000)
})

it('stops a row a real server sends at more than 64 MB, before holding it', async () => {
  const source = await open()
  const before = process.memoryUsage().arrayBuffers
  const err = await readSnapshot(source, (db) => db.queryArrays(`SELECT repeat('x', 65 * 1024 * 1024)`)).catch((e) => e)
  expect(err).toBeInstanceOf(SourceWireError)
  expect(err.message).toBe('The source sent one row of 65 MB; Backenly reads at most 64 MB at once, so it stopped reading the source.')
  expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024)
})
