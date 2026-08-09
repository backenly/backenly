/**
 * SQL RECORDER — the audit trail says what actually ran
 * ------------------------------------------------------
 * The audit row already answered what changed, why, and whether it held. It
 * could not answer "show me the statement". The change was derivable by diffing
 * two full-schema snapshots; the statement itself was never stored.
 *
 * The capture happens at the driver rather than in each executor, and that is
 * the property most worth pinning: an executor added later cannot forget to
 * report its SQL, because it is never asked to. A convention would have failed
 * silently — the audit row would simply lose the statement and nothing would
 * break.
 *
 * Part 1 is pure (classification and scoping). Part 2 drives a real fix through
 * the real engine against a real database and reads what came out the other end.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import {
  withSqlCapture,
  noteStatement,
  isCapturing,
  isMutatingStatement,
  installSqlRecorder,
} from '@/lib/execution/sql-recorder'
import { runAutoFix } from '@/lib/core/auto-fix-engine'

describe('what counts as a statement worth recording', () => {
  test.each([
    'CREATE INDEX idx ON t (c)',
    '  alter table t add constraint fk foreign key (a) references b(id)',
    'DROP INDEX x',
    'VACUUM (ANALYZE) t',
    'REINDEX INDEX CONCURRENTLY i',
    'CREATE POLICY p ON t USING (true)',
    'GRANT SELECT ON t TO anon',
  ])('records the mutation %s', (sql) => {
    expect(isMutatingStatement(sql)).toBe(true)
  })

  test.each([
    'SELECT 1',
    '  select indexdef from pg_indexes where schemaname = $1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
  ])('ignores the read %s', (sql) => {
    expect(isMutatingStatement(sql)).toBe(false)
  })

  test('a read that merely mentions a keyword is still a read', () => {
    // Matching a substring anywhere would file this as a mutation, and the
    // catalog lookups around every fix are full of exactly this shape.
    expect(isMutatingStatement(
      `SELECT indexdef FROM pg_indexes WHERE indexdef LIKE '%CREATE UNIQUE%'`,
    )).toBe(false)
  })

  test('leading comments do not hide the real first keyword', () => {
    expect(isMutatingStatement('-- rebuild it\nREINDEX INDEX i')).toBe(true)
    expect(isMutatingStatement('/* why */ SELECT 1')).toBe(false)
  })
})

describe('capture scoping', () => {
  test('nothing is recorded outside a capture', () => {
    expect(isCapturing()).toBe(false)
    noteStatement('CREATE INDEX i ON t (c)') // must not throw
  })

  test('a capture collects only what ran inside it', async () => {
    const { statements } = await withSqlCapture(async () => {
      noteStatement('CREATE INDEX a ON t (c)')
      noteStatement('SELECT 1')
      noteStatement('DROP INDEX a')
    })
    expect(statements.map(s => s.sql)).toEqual([
      'CREATE INDEX a ON t (c)',
      'DROP INDEX a',
    ])
  })

  test('bound parameters travel with the statement', async () => {
    const { statements } = await withSqlCapture(async () => {
      noteStatement('CREATE INDEX i ON t (c)', ['workspace_x', 42])
    })
    expect(statements[0].params).toEqual(['workspace_x', '42'])
  })

  test('a nested capture reports into the outer scope, not a private one', async () => {
    // A fix that calls another governed helper must produce ONE ordered list.
    // Opening a second scope would hide the inner statements from the audit row.
    const { statements } = await withSqlCapture(async () => {
      noteStatement('CREATE INDEX outer_first ON t (c)')
      await withSqlCapture(async () => {
        noteStatement('CREATE INDEX inner_one ON t (c)')
      })
      noteStatement('CREATE INDEX outer_last ON t (c)')
    })
    expect(statements.map(s => s.sql)).toEqual([
      'CREATE INDEX outer_first ON t (c)',
      'CREATE INDEX inner_one ON t (c)',
      'CREATE INDEX outer_last ON t (c)',
    ])
  })

  test('concurrent captures do not leak into each other', async () => {
    // AsyncLocalStorage is what makes this true; a module-level array would
    // interleave two projects' fixes into one audit row.
    const [a, b] = await Promise.all([
      withSqlCapture(async () => {
        await new Promise(r => setTimeout(r, 10))
        noteStatement('CREATE INDEX from_a ON t (c)')
      }),
      withSqlCapture(async () => {
        noteStatement('CREATE INDEX from_b ON t (c)')
      }),
    ])
    expect(a.statements.map(s => s.sql)).toEqual(['CREATE INDEX from_a ON t (c)'])
    expect(b.statements.map(s => s.sql)).toEqual(['CREATE INDEX from_b ON t (c)'])
  })
})

describe('the middleware captures real driver traffic', () => {
  test('a raw execute inside a capture is recorded with its parameters', async () => {
    installSqlRecorder(prisma as any)
    // A TEMP table: real DDL and a real parameterised INSERT, scoped to this
    // session so the test leaves nothing behind. (`SET LOCAL` looked like the
    // obvious no-op mutation and is not one — PostgreSQL does not accept bind
    // parameters there at all.)
    const { statements } = await withSqlCapture(async () => {
      // Reads run all around a real fix and must be ignored…
      await prisma.$queryRawUnsafe(`SELECT 1 AS x`)
      await prisma.$executeRawUnsafe(`CREATE TEMP TABLE _sql_recorder_probe (v text)`)
      await prisma.$executeRawUnsafe(`INSERT INTO _sql_recorder_probe (v) VALUES ($1)`, 'captured')
    })
    expect(statements.map(s => s.sql)).toEqual([
      'CREATE TEMP TABLE _sql_recorder_probe (v text)',
      'INSERT INTO _sql_recorder_probe (v) VALUES ($1)',
    ])
    expect(statements[1].params).toEqual(['captured'])
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS _sql_recorder_probe`).catch(() => {})
  })
})

// ── Part 2: end to end through the real engine ───────────────────────────────

describe('an autonomous fix records the statement it ran', () => {
  let userId: string
  let projectId: string
  let schema: string

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `sql-recorder-${Date.now()}@example.test`, password: 'x', name: 'rec' },
    })
    userId = user.id
    const project = await prisma.project.create({ data: { name: 'sql-recorder-test', userId } })
    projectId = project.id
    schema = `workspace_${projectId}`

    const raw = (sql: string) => prisma.$executeRawUnsafe(sql)
    await raw(`CREATE SCHEMA "${schema}"`)
    await raw(`CREATE TABLE "${schema}"."users" (id uuid primary key default gen_random_uuid(), email text)`)
    await raw(`CREATE TABLE "${schema}"."posts" (
      id serial primary key, user_id uuid REFERENCES "${schema}"."users"(id), title text
    )`)
    await prisma.table.create({
      data: { projectId, name: 'posts', schema: '{}' } as any,
    }).catch(() => {})
  }, 60_000)

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
    await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  })

  test('the CREATE INDEX reaches rollbackData and the audit row', async () => {
    const finding = await prisma.healthFinding.create({
      data: {
        projectId,
        type: 'missing_fk_index',
        severity: 'warning',
        status: 'open',
        details: { tableName: 'posts', columnName: 'user_id', location: 'posts.user_id' } as any,
      },
    })

    const result = await runAutoFix(finding.id, projectId, true)
    expect(result.outcome).toBe('auto_fixed')

    const statements = (result.rollbackData as any)?.statements ?? []
    expect(statements.length).toBeGreaterThan(0)
    const ddl = statements.map((s: any) => s.sql).join('\n')
    // The actual statement, not a rendering of the finding type.
    expect(ddl).toMatch(/CREATE INDEX/i)
    expect(ddl).toContain('"posts"')
    expect(ddl).toContain('"user_id"')
    expect(ddl).toContain(schema)

    // Catalog lookups run all around this fix. None of them belongs in an audit
    // row a human reads to find out what changed.
    expect(ddl).not.toMatch(/SELECT/i)

    const audit = await prisma.auditLog.findFirst({
      where: { projectId, action: 'HEALTH_AUTO_FIXED' },
      orderBy: { timestamp: 'desc' },
    })
    const parsed = JSON.parse(audit?.details ?? '{}')
    expect(parsed.statements?.length).toBe(statements.length)
    expect(parsed.statements[0].sql).toBe(statements[0].sql)
  }, 120_000)
})
