/**
 * THE TABLE THE OPERATOR PICKED IS THE TABLE THAT GETS REFERENCED
 * ==============================================================
 * The foreign-key executor INFERS its target from the column name when no
 * target is supplied. That is right for the AI path, which is repairing a
 * schema it just generated from names it chose. It is wrong for a picker: an
 * operator who selects a table has stated the answer, and inferring a different
 * one produces a foreign key that is plausible, silently wrong, and discovered
 * later as data pointing at the wrong parent.
 *
 * The UI originally passed the chosen table through `expression`. That looked
 * correct and was not: the executor parses `expression` with a regex expecting
 * `table(column)`, so a bare table name failed to match, `referencedTable`
 * stayed undefined, and inference ran anyway. The choice was discarded with no
 * error. These tests exist because that bug is invisible in any test that picks
 * the same table inference would have guessed.
 *
 * So the fixture is built so that INFERENCE AND THE CHOICE DISAGREE, and the
 * assertion is on `pg_constraint` — what the database actually did, not what
 * the executor reported.
 *
 * Runs against a real PostgreSQL. The question is entirely about catalog state.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { addWorkspaceConstraint } from '@/lib/services/tableLifecycle'

let userId: string
let projectId: string
let schema: string

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

/** What the database says this column actually references. */
async function referencedTableOf(table: string, column: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ referenced: string }>>(
    `SELECT ccu.table_name AS referenced
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
        AND tc.table_name = $2
        AND kcu.column_name = $3
      LIMIT 1`,
    schema, table, column,
  )
  return rows[0]?.referenced ?? null
}

async function hasUniqueOn(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
    `SELECT 1 AS one
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'UNIQUE'
        AND tc.table_schema = $1 AND tc.table_name = $2 AND kcu.column_name = $3
      LIMIT 1`,
    schema, table, column,
  )
  return rows.length > 0
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `constraint-picker-${Date.now()}@example.test`, password: 'x', name: 'constraint picker' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'constraint-picker-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  await raw(`CREATE SCHEMA "${schema}"`)

  // The trap, built deliberately. `owner_id` infers a table called `owners`,
  // and `owners` EXISTS — so inference succeeds and produces a wrong answer
  // rather than an error. `organizations` is what the operator picks.
  await raw(`CREATE TABLE "${schema}"."owners" (id serial primary key, label text)`)
  await raw(`CREATE TABLE "${schema}"."organizations" (id serial primary key, label text)`)
  await raw(`CREATE TABLE "${schema}"."documents" (
    id serial primary key,
    owner_id integer,
    code text
  )`)

  // Platform Table rows, because the executor's dependency resolver looks for
  // them and injects a CREATE_TABLE when one is missing. A raw-SQL-only fixture
  // therefore runs a table-creation path first, whose global foreign-key repair
  // infers `owner_id -> owners` before the explicit constraint is ever reached.
  // That is a property of the fixture, not of the picker: every table the table
  // editor lists has a row here.
  for (const name of ['owners', 'organizations', 'documents']) {
    await prisma.table.create({ data: { projectId, name, schema } })
  }
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('foreign key from an explicit choice', () => {
  test('references the chosen table, not the one the column name implies', async () => {
    const result = await addWorkspaceConstraint(projectId, {
      tableName: 'documents',
      columnName: 'owner_id',
      constraintType: 'foreign_key',
      referencedTable: 'organizations',
    })
    expect(result.success).toBe(true)

    // The assertion that matters. `owners` exists and is what inference picks,
    // so this passing by accident is not possible.
    expect(await referencedTableOf('documents', 'owner_id')).toBe('organizations')
  }, 60_000)

  test('the wrong target is genuinely reachable, so the test above proves something', async () => {
    // Guards the guard. If inference stopped resolving `owner_id` to `owners`,
    // the test above would still pass while no longer testing anything, and
    // this states the precondition it depends on.
    const { deriveFkBase } = await import('@/lib/db/fk-shape')
    expect(deriveFkBase('owner_id')).toBe('owner')

    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'owners'`,
      schema,
    )
    expect(rows).toHaveLength(1)
  })
})

describe('the other constraint types the picker offers', () => {
  test('unique applies to the named column', async () => {
    const result = await addWorkspaceConstraint(projectId, {
      tableName: 'documents',
      columnName: 'code',
      constraintType: 'unique',
    })
    expect(result.success).toBe(true)
    expect(await hasUniqueOn('documents', 'code')).toBe(true)
  }, 60_000)

  test('a check constraint is enforced, not merely recorded', async () => {
    await raw(`ALTER TABLE "${schema}"."documents" ADD COLUMN price integer`)
    const result = await addWorkspaceConstraint(projectId, {
      tableName: 'documents',
      columnName: 'price',
      constraintType: 'check',
      expression: 'price > 0',
    })
    expect(result.success).toBe(true)

    // Asserting the catalog row would not prove the constraint does anything.
    await expect(
      raw(`INSERT INTO "${schema}"."documents"(price) VALUES (-5)`)
    ).rejects.toThrow()
    await expect(
      raw(`INSERT INTO "${schema}"."documents"(price) VALUES (5)`)
    ).resolves.toBeDefined()
  }, 60_000)

  test('a foreign key on a column that is not FK-shaped is refused', async () => {
    // The UI blocks this before submitting, using the same rule. This asserts
    // the server refuses it too, so the UI guard is a convenience rather than
    // the enforcement.
    const result = await addWorkspaceConstraint(projectId, {
      tableName: 'documents',
      columnName: 'code',
      constraintType: 'foreign_key',
      referencedTable: 'organizations',
    })
    expect(result.success).toBe(false)
  }, 60_000)
})

describe('partial failure is reported, not hidden', () => {
  test('a failing constraint leaves the successful ones in place', async () => {
    // The table editor applies each requested constraint separately and reports
    // which ones did not take. This is the server-side half of that: one
    // failure must not roll back the others, or the operator's report would be
    // describing a state the database is not in.
    await raw(`ALTER TABLE "${schema}"."documents" ADD COLUMN ref_id integer`)

    const good = await addWorkspaceConstraint(projectId, {
      tableName: 'documents',
      columnName: 'ref_id',
      constraintType: 'unique',
    })
    const bad = await addWorkspaceConstraint(projectId, {
      tableName: 'documents',
      columnName: 'ref_id',
      constraintType: 'foreign_key',
      referencedTable: 'no_such_table',
    })

    expect(good.success).toBe(true)
    expect(bad.success).toBe(false)
    // The UNIQUE survived the FK failure.
    expect(await hasUniqueOn('documents', 'ref_id')).toBe(true)
  }, 60_000)
})
