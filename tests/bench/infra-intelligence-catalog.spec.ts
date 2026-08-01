/**
 * Every pg_stat_* query in infra-intelligence must actually run.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 * Three detectors selected `tablename` FROM `pg_stat_user_tables`. That view
 * exposes (schemaname, relname) — `tablename` belongs to `pg_tables`. So every
 * call raised 42703, the module's documented "never throws — returns partial
 * report on any query failure" contract swallowed it, and each detector
 * returned `[]`. An empty list reads as "no hot tables, no partitioning
 * pressure, no realtime write load" — indistinguishable from a healthy project.
 *
 * They had never once run. Found by ranking production Postgres errors by
 * count: 136 occurrences of `column "tablename" does not exist`, on a path no
 * dashboard watched.
 *
 * ── Why the test is shaped like this ────────────────────────────────────────
 * The detectors are module-private and take a live `Pool`, so there is nothing
 * to import. Asserting on the source text would only prove the file says what
 * it says. Instead this extracts every real query targeting a `pg_stat_*` view
 * and EXECUTES it against Postgres — the only authority on whether a column
 * exists. Any future catalog-name mistake in this file fails here, not silently
 * in production six days later.
 */

import * as fs from 'fs'
import * as path from 'path'
import { Pool } from 'pg'

const SOURCE = path.join(process.cwd(), 'lib', 'ai', 'infra-intelligence.ts')
const CONN = process.env.BENCH_DATABASE_URL || process.env.DATABASE_URL || ''

/**
 * Pull every template-literal SQL string that reads a pg_stat_* view.
 * Deliberately greps the real file rather than a fixture: the point is to catch
 * a query somebody adds tomorrow.
 */
function extractPgStatQueries(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/`([^`]*\bFROM\s+pg_stat_[a-z_]+[^`]*)`/gi)) {
    out.push(m[1])
  }
  return out
}

describe('infra-intelligence pg_stat queries', () => {
  const src = fs.readFileSync(SOURCE, 'utf8')
  const queries = extractPgStatQueries(src)

  it('finds the pg_stat queries it is meant to guard', () => {
    // If this drops to zero the extractor silently stopped guarding anything —
    // a green suite proving nothing, which is the exact failure class above.
    expect(queries.length).toBeGreaterThanOrEqual(3)
  })

  it('never selects `tablename` from a pg_stat_* view', () => {
    // pg_stat_user_tables has relname; pg_tables has tablename. Conflating them
    // is the specific mistake that cost three detectors six days of silence.
    const offenders = queries.filter((q) => /select[\s\S]*?\btablename\b(?!\s*=)/i.test(q) &&
      !/relname\s+AS\s+tablename/i.test(q))
    expect(offenders).toEqual([])
  })

  it('no query references a column its pg_stat view does not have', async () => {
    const pool = new Pool({ connectionString: CONN, max: 2 })
    const columnErrors: string[] = []
    try {
      for (const q of queries) {
        // Bind every placeholder with a schema that matches nothing: the
        // assertion is that Postgres ACCEPTS the statement, not that it returns
        // rows.
        const params = Math.max(
          0,
          ...[...q.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
        )
        try {
          await pool.query(q, Array.from({ length: params }, () => 'no_such_schema'))
        } catch (err: any) {
          // 42P01 undefined_table is ACCEPTABLE and only for optional
          // extensions: `pg_stat_statements` is not installed everywhere, and
          // the module documents it as "if extension available". Treating that
          // as a failure would make this suite red on a stock Postgres and
          // teach everyone to skip it.
          //
          // 42703 undefined_column is NEVER acceptable — a core catalog view
          // does not gain or lose columns per environment, so a column error is
          // always a real bug, and it is exactly the bug this file exists for.
          if (err?.code === '42P01' && /pg_stat_statements/i.test(q)) continue
          columnErrors.push(`[${err?.code}] ${err?.message} :: ${q.slice(0, 80).replace(/\s+/g, ' ')}`)
        }
      }
    } finally {
      await pool.end().catch(() => {})
    }
    expect(columnErrors).toEqual([])
  }, 60_000)
})
