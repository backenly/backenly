/**
 * When the read-only connection itself fails, the caller learns that nothing
 * ran, and nothing about the database behind it.
 *
 * On production, from 2026-11-02 to 2026-11-09, every run_query call and every
 * query in the console's SQL tab answered with PostgreSQL's own text:
 *
 *   no pg_hba.conf entry for host "10.0.x.x", user "bkn_ro_0123456789ab",
 *   database "backenly", no encryption          (SQLSTATE 28000)
 *
 * It went to customers and into their agents' context windows with an internal
 * address, the project's role and the database name in it. The cause was a
 * client built without TLS (tests/unit/read-only-connection.spec.ts); this
 * file pins what anyone sees when a connection fails for any reason.
 *
 * The failure is produced the way production produced it, as a class-28
 * refusal at login: the project's read-only role is set NOLOGIN.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { execFileSync } from 'child_process'
import { prisma } from '@/lib/db/prisma'
import { runReadQuery, ReadQueryError } from '@/lib/mcp/read-query'

let userId: string
let projectId: string
let schema: string
let roleName = ''

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

beforeAll(async () => {
  // The SECURITY DEFINER helpers that provision the per-project bkn_ro_ role
  // (see __tests__/database/sql-workspace-isolation.test.ts for why options
  // come before the database argument).
  execFileSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', process.env.TEST_DATABASE_URL!],
    { stdio: 'pipe' },
  )
  const user = await prisma.user.create({
    data: { email: `rq-conn-${Date.now()}@example.test`, password: 'x', name: 'read query connection' },
  })
  userId = user.id
  projectId = (await prisma.project.create({ data: { name: 'read-query-connection', userId } })).id
  schema = `workspace_${projectId}`
  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."notes" (id serial primary key, body text)`)
  await raw(`INSERT INTO "${schema}"."notes"(body) VALUES ('one')`)
}, 180_000)

afterAll(async () => {
  if (roleName) await raw(`ALTER ROLE "${roleName}" LOGIN`).catch(() => {})
  await raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

describe('the read-only connection', () => {
  test('reads, when it can connect', async () => {
    const r = await runReadQuery(projectId, 'SELECT body FROM notes', 10)
    expect(r.rows).toEqual([{ body: 'one' }])
    const cred = await prisma.databaseCredential.findUnique({ where: { projectId_mode: { projectId, mode: 'READ_ONLY' } } })
    roleName = cred!.roleName
    expect(roleName).toMatch(/^bkn_ro_/)
  }, 60_000)

  test('a login refused by the server is reported as Backenly\'s side, with nothing about the database in it', async () => {
    await raw(`ALTER ROLE "${roleName}" NOLOGIN`)
    let caught: unknown
    try {
      await runReadQuery(projectId, 'SELECT body FROM notes', 10)
    } catch (err) {
      caught = err
    } finally {
      await raw(`ALTER ROLE "${roleName}" LOGIN`)
    }
    expect(caught).toBeInstanceOf(ReadQueryError)
    const e = caught as ReadQueryError
    expect(e.code).toBe('DATABASE_UNAVAILABLE')
    expect(e.status).toBe(503)
    expect(e.message).toMatch(/didn't run/)
    // What PostgreSQL said (`role "bkn_ro_…" is not permitted to log in`) stays in the server log.
    expect(e.message).not.toContain(roleName)
    expect(e.message).not.toMatch(/bkn_ro|pg_hba|127\.0\.0\.1|localhost|backenly_test|not permitted/i)
  }, 60_000)

  test("the statement's own mistakes are still the caller's to read", async () => {
    let caught: any
    try {
      await runReadQuery(projectId, 'SELECT nope FROM notes', 10)
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeInstanceOf(ReadQueryError)
    expect(caught?.code).toBe('42703')
    expect(String(caught?.message)).toMatch(/nope/)
  }, 60_000)
})
