/**
 * A PROBE THAT CANNOT SEE ROWS MUST NOT REPORT THERE ARE NONE
 * ===========================================================
 *
 * `tests/unit/probe-query-contract.spec.ts` guards the sibling failure: a probe
 * whose query ERRORED reporting "nothing found". This one guards the subtler
 * version, where nothing errors at all.
 *
 * `serviceRows` counted tenant rows through `prisma.$queryRawUnsafe`, which
 * sets no RLS session variables. Every workspace table has FORCE ROW LEVEL
 * SECURITY, which binds the table's owner too, so the policy's claim was null
 * and the count came back 0 for a table full of rows. No exception, no empty
 * result set to be suspicious of, just a confident wrong number.
 *
 * ── Why it survived review ────────────────────────────────────────────────
 *
 * It reads correctly in development. The local role is a superuser and
 * superusers bypass RLS; production's role is NOSUPERUSER NOBYPASSRLS by
 * design. Reproduced by hand against Postgres 16 while writing this:
 *
 *     rows physically in the table                        3
 *     the probe's exact query, as the production role     0
 *     the same query with request.jwt.claims set          2
 *
 * ── Why it was the worst probe to get wrong ───────────────────────────────
 *
 * `no_rows` is the SOLE prediction of `table_genuinely_empty` in the catalog.
 * A blinded count therefore did not degrade the diagnosis into uncertainty; it
 * drove it confidently to "the table contains no rows" about a table the
 * customer's app was reading from, and that conclusion is what the Review
 * Queue then showed a human.
 *
 * ── Why this test is source-level ─────────────────────────────────────────
 *
 * Because a behavioural test would pass against the BROKEN code. The test
 * database connects as a superuser, so RLS is bypassed and both the old and
 * the new implementation return the right number. A test that cannot fail on
 * the bug it was written for is worse than no test, so the guard is the
 * property instead: tenant rows are read through the claimed helper, always.
 */

import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * Source with comments removed.
 *
 * These files explain the bug they fixed, in prose, quoting the broken code.
 * Asserting "this string does not appear" against raw source therefore matches
 * the explanation and fails on a file that is correct. The assertions below are
 * about what the code DOES, so they read code only.
 */
const codeOf = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const PROBES = 'lib/autonomy/hypothesis/probes.ts'

/**
 * Reads that RLS does not filter, and so correctly need no claim.
 *
 * `information_schema` and the `pg_*` catalogs are visible regardless of row
 * security. Listing them explicitly keeps the rule below narrow: the point is
 * not "never use raw SQL in a probe", it is "never read a TENANT'S ROWS
 * without saying who is asking".
 */
const CATALOG_SOURCES = [
  'information_schema.',
  'pg_policies',
  'pg_class',
  'pg_namespace',
  'pg_catalog.',
  'pg_stat_',
  'pg_index',
  'pg_constraint',
]

describe('hypothesis probes read tenant rows as somebody', () => {
  const src = read(PROBES)
  const code = codeOf(PROBES)

  it('counts rows through the claimed helper, not through raw Prisma', () => {
    expect(src).toContain('queryWorkspaceAsOwner')
    // The two tenant-row probes by name, so deleting the import while leaving
    // a raw read behind cannot pass.
    const serviceRows = src.slice(src.indexOf('export const serviceRows'))
    const body = serviceRows.slice(0, serviceRows.indexOf('\n}'))
    expect(body).toContain('queryWorkspaceAsOwner')
    expect(body).not.toContain('$queryRawUnsafe')
  })

  it('counts soft-deleted rows through it too', () => {
    const soft = src.slice(src.indexOf('export const softDeleted'))
    const body = soft.slice(0, soft.indexOf('\n}'))
    // The information_schema lookup in this probe legitimately stays raw, so
    // this asserts the tenant-row count specifically.
    expect(body).toContain('queryWorkspaceAsOwner')
    expect(body).toMatch(/FILTER \(WHERE deleted_at IS NULL\)/)
  })

  it('never issues a raw query against a workspace schema', () => {
    // The general rule, stated structurally. Any `$queryRawUnsafe` whose SQL
    // interpolates the workspace schema is reading tenant rows as nobody.
    const rawCalls = [...code.matchAll(/\$queryRawUnsafe[\s\S]{0,120}?`([^`]*)`/g)].map(m => m[1])
    expect(rawCalls.length).toBeGreaterThan(0) // anti-vacuous: the regex still matches

    for (const sql of rawCalls) {
      if (!sql.includes('${schema}')) continue
      const readsCatalog = CATALOG_SOURCES.some(c => sql.includes(c))
      expect(readsCatalog).toBe(true)
    }
  })

  it('throws rather than counting zero when it could not count', () => {
    // "I could not count" and "I counted none" are different observations and
    // only one of them is evidence. A `.catch(() => [])` here would put the
    // fabricated-evidence bug straight back.
    expect(code).toContain('could not count rows in')
    expect(code).toContain('could not count soft-deleted rows in')
    expect(code).not.toMatch(/\.catch\(\(\)\s*=>\s*\[\]\)/)
  })
})

describe('probes resolve the workspace schema rather than computing it', () => {
  const src = read(PROBES)
  const code = codeOf(PROBES)

  it('asks the resolver, which prefers the stored name', () => {
    // `Workspace.postgresSchema` is authoritative. A hardcoded
    // `workspace_${projectId}` names a schema that does not exist for any
    // project whose stored name differs, and every catalog probe then reads an
    // empty information_schema and reports the table missing.
    expect(code).toContain('resolveWorkspaceSchema')
    expect(code).not.toMatch(/`workspace_\$\{projectId\}`/)
    expect(code).not.toMatch(/`workspace_\$\{ctx\.projectId\}`/)
  })
})
