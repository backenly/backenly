/**
 * READ-ONLY IS A DATABASE PROPERTY, NOT A PARSER'S OPINION
 * =======================================================
 * `/api/database/query` used to execute on the APPLICATION's own connection —
 * `queryRaw` through `getWorkspacePostgresClient` — with a deny-list regex and
 * a schema-name matcher as its only tenant boundary. Before the credential
 * split that connection was a SUPERUSER, so the endpoint was an unaudited SQL
 * passthrough with regex-grade isolation. It had no callers and no tests.
 *
 * Its sibling `/api/cli/query` was moved onto the governed engine in July for
 * exactly this reason, and its header says why: "a parser can always be
 * out-argued". This route was left behind.
 *
 * So these tests do not check that a regex refuses things. They call
 * `runReadQuery` — the engine both routes now share — and assert that
 * **PostgreSQL** refuses, which is the only claim worth making. The parser is
 * tested separately and only as defence in depth.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { execFileSync } from 'child_process'
import { prisma } from '@/lib/db/prisma'
import { runReadQuery, ReadQueryError } from '@/lib/mcp/read-query'
import { validateConsoleSql } from '@/lib/sql-console/guard'

let userId: string
let projectId: string
let otherProjectId: string
let schema: string
let otherSchema: string

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

/**
 * Install the privileged helpers this engine depends on.
 *
 * `runReadQuery` provisions a per-project `bkn_ro_` role through the
 * SECURITY DEFINER functions in scripts/setup-direct-access.sql, which a
 * superuser installs once. Without them EVERY query fails — including the
 * legitimate ones — and the refusal tests below would pass because nothing
 * works at all rather than because PostgreSQL refused the right things.
 *
 * That is the trap this repository has hit before: a clean check that is
 * actually a blind one. So the positive reads are here specifically to prove
 * the negative ones mean something, and this makes them possible.
 */
function installDirectAccessHelpers(): void {
  // Options BEFORE the connection string, and the database passed with -d.
  // With the URL as a leading positional argument this psql treats every
  // following flag as an extra argument and ignores it — printing warnings,
  // exiting 0, and installing nothing. The suite then failed with
  // "function ... does not exist" from a step that had reported success.
  execFileSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', process.env.TEST_DATABASE_URL!],
    { stdio: 'pipe' }
  )
}

beforeAll(async () => {
  installDirectAccessHelpers()

  const user = await prisma.user.create({
    data: { email: `sqlws-${Date.now()}@example.test`, password: 'x', name: 'sql workspace' },
  })
  userId = user.id

  const project = await prisma.project.create({ data: { name: 'sql-workspace-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  // A second tenant with data worth stealing. Without it, "cannot read another
  // schema" would pass against a database where no other schema existed.
  const other = await prisma.project.create({ data: { name: 'sql-workspace-victim', userId } })
  otherProjectId = other.id
  otherSchema = `workspace_${otherProjectId}`

  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."notes" (id serial primary key, body text)`)
  await raw(`INSERT INTO "${schema}"."notes"(body) VALUES ('mine one'), ('mine two')`)

  await raw(`CREATE SCHEMA "${otherSchema}"`)
  await raw(`CREATE TABLE "${otherSchema}"."secrets" (id serial primary key, body text)`)
  await raw(`INSERT INTO "${otherSchema}"."secrets"(body) VALUES ('not yours')`)
}, 180_000)

afterAll(async () => {
  await raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await raw(`DROP SCHEMA IF EXISTS "${otherSchema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

describe('reading its own data', () => {
  test('a plain SELECT returns rows', async () => {
    const r = await runReadQuery(projectId, 'SELECT body FROM notes ORDER BY id', 50)
    expect(r.rows.map(x => x.body)).toEqual(['mine one', 'mine two'])
  }, 60_000)

  test('an aggregate works, which the filter DSL could not express', async () => {
    // The reason reads moved to SQL at all: joins, aggregates and projections
    // are what the typed filter language cannot say.
    const r = await runReadQuery(projectId, 'SELECT count(*) AS n FROM notes', 50)
    expect(Number((r.rows[0] as any).n)).toBe(2)
  }, 60_000)

  test('the row cap is applied in Postgres and reported honestly', async () => {
    const r = await runReadQuery(projectId, 'SELECT body FROM notes ORDER BY id', 1)
    expect(r.rows).toHaveLength(1)
    // Truncation is REPORTED, not inferred from rowCount === limit, which
    // cannot tell "exactly one row" from "there are more".
    expect(r.truncated).toBe(true)
  }, 60_000)
})

describe('the boundary PostgreSQL enforces', () => {
  test('a write is refused by the database, not by the parser', async () => {
    // Deliberately bypasses validateConsoleSql and goes straight to the
    // engine, because the claim under test is that the parser is NOT what
    // stops this. The role has no INSERT grant and the transaction is
    // BEGIN READ ONLY.
    await expect(
      runReadQuery(projectId, "INSERT INTO notes(body) VALUES ('injected')", 10)
    ).rejects.toThrow()

    // And nothing was written.
    const after = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "${schema}"."notes"`
    )
    expect(Number(after[0].n)).toBe(2)
  }, 60_000)

  test('DDL is refused the same way', async () => {
    await expect(
      runReadQuery(projectId, 'CREATE TABLE sneaky (id int)', 10)
    ).rejects.toThrow()

    const exists = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM information_schema.tables
        WHERE table_schema = '${schema}' AND table_name = 'sneaky'`
    )
    expect(Number(exists[0].n)).toBe(0)
  }, 60_000)

  test('another tenant schema is refused by a missing grant', async () => {
    // The important one. A schema-qualified read of a REAL other workspace,
    // which a regex would have to recognise to stop. Here it fails because the
    // bkn_ro_ role was never granted USAGE on that schema.
    await expect(
      runReadQuery(projectId, `SELECT body FROM "${otherSchema}".secrets`, 10)
    ).rejects.toThrow()
  }, 60_000)

  test('the other tenant genuinely holds readable data', async () => {
    // Guards the guard: if the victim schema were empty or absent, the test
    // above would pass while proving nothing.
    const rows = await prisma.$queryRawUnsafe<Array<{ body: string }>>(
      `SELECT body FROM "${otherSchema}"."secrets"`
    )
    expect(rows.map(r => r.body)).toEqual(['not yours'])
  })
})

describe('the parser, as defence in depth only', () => {
  test('refuses a write with a pointer at the governed path', () => {
    const v = validateConsoleSql("UPDATE notes SET body = 'x'", projectId)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.kind).toBe('write')
      // Its value is the message, not the enforcement: it turns a permission
      // error into a route back into governance.
      expect(v.reason.length).toBeGreaterThan(0)
    }
  })

  test('refuses more than one statement', () => {
    const v = validateConsoleSql('SELECT 1; SELECT 2', projectId)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.kind).toBe('multi')
  })

  test('admits a plain SELECT', () => {
    const v = validateConsoleSql('SELECT body FROM notes', projectId)
    expect(v.ok).toBe(true)
  })
})
