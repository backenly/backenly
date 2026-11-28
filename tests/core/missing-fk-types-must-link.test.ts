/**
 * A MISSING FOREIGN KEY IS OFFERED ONLY WHERE POSTGRESQL CAN MAKE ONE
 * ==================================================================
 * Production QA, 2026-11-21 and again 2026-11-27: `reviews.user_id` was text
 * (the agent stores the signed-in user that way) and `users.id` is a uuid.
 * Backenly offered a foreign key between them from the column's name, and
 * "Approve & fix all 4" answered four HTTP 500s:
 *
 *   foreign key constraint "fk_reviews_user" cannot be implemented …
 *   incompatible types: text and uuid
 *
 * A column's name says what it points at, never whether a key can be made.
 * Pinned here against a real database, so that every "can" and "cannot" is
 * PostgreSQL's own answer and not this repository's opinion of it:
 *
 *   1. The detector offers a key only between types that link.
 *   2. The repair, asked for one that does not, refuses in plain words and
 *      changes nothing.
 *   3. Every pair the rule calls linkable, PostgreSQL does link.
 *   4. Every pair it calls unlinkable, PostgreSQL does refuse.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { detectFkColumnsMissingConstraints } from '@/lib/core/drift-detector'
import { repairForeignKeyColumn } from '@/lib/ai/fk-repair'

let userId: string
let projectId: string
let schema: string

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

async function foreignKeysOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2
      ORDER BY kcu.column_name`,
    schema, table,
  )
  return rows.map((r) => r.column_name)
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `fk-types-${Date.now()}@example.test`, password: 'x', name: 'fk types' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'fk-types-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."users" (id uuid primary key default gen_random_uuid(), email text)`)
  await raw(`CREATE TABLE "${schema}"."posts" (id serial primary key, title text)`)
  await raw(`CREATE TABLE "${schema}"."notes" (id text primary key, body text)`)
  await raw(`CREATE TABLE "${schema}"."tags" (name text primary key)`)
  // The same type on both sides.
  await raw(`CREATE TABLE "${schema}"."orders" (id serial primary key, user_id uuid NOT NULL)`)
  // QA's table: the signed-in user as text beside a uuid key, and a whole
  // number wider than the key it points at.
  await raw(`CREATE TABLE "${schema}"."reviews" (id serial primary key, user_id text NOT NULL, post_id bigint, body text)`)
  // A varchar beside a text key.
  await raw(`CREATE TABLE "${schema}"."note_links" (id serial primary key, note_id varchar(64))`)
  // A table whose target has no id at all.
  await raw(`CREATE TABLE "${schema}"."taggings" (id serial primary key, tag_id uuid)`)
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('the detector', () => {
  test('offers a key only where the two types link', async () => {
    const findings = await detectFkColumnsMissingConstraints(projectId)
    const offered = findings
      .map((f) => {
        const d = f.details as { tableName: string; columnName: string; referencedTable: string }
        return `${d.tableName}.${d.columnName} → ${d.referencedTable}`
      })
      .sort()
    expect(offered).toEqual(['note_links.note_id → notes', 'orders.user_id → users', 'reviews.post_id → posts'])
  })
})

describe('the repair, asked for a key PostgreSQL cannot make', () => {
  test('refuses text beside a uuid in plain words, and changes nothing', async () => {
    expect(await repairForeignKeyColumn(projectId, 'reviews', 'user_id', 'users')).toEqual({
      success: false,
      code: 'INCOMPATIBLE_TYPES',
      message:
        '"reviews"."user_id" is text and "users"."id" is uuid, and PostgreSQL cannot link columns of those two types ' +
        "with a foreign key, so none was added and nothing changed. To link them, change the column's type to uuid first.",
      referencedTable: 'users',
    })
    expect(await foreignKeysOf('reviews')).toEqual([])
  })

  test('refuses a table with no id to reference', async () => {
    expect(await repairForeignKeyColumn(projectId, 'taggings', 'tag_id', 'tags')).toMatchObject({
      success: false,
      code: 'REFERENCED_KEY_NOT_FOUND',
      message: '"tags" has no "id" column to reference, so no foreign key was added and nothing changed.',
    })
    expect(await foreignKeysOf('taggings')).toEqual([])
  })

  // What the pre-check exists to replace: PostgreSQL's own refusal of the
  // same pair, which is what reached the approval card as a 500.
  test('is refusing what PostgreSQL itself refuses', async () => {
    await expect(
      raw(`ALTER TABLE "${schema}"."reviews" ADD CONSTRAINT fk_probe FOREIGN KEY (user_id) REFERENCES "${schema}"."users"(id)`),
    ).rejects.toThrow(/cannot be implemented|42804/)
  })
})

describe('every pair the rule calls linkable', () => {
  test('PostgreSQL links: the same type, a wider whole number, and varchar beside text', async () => {
    for (const [table, column, target] of [
      ['orders', 'user_id', 'users'],
      ['reviews', 'post_id', 'posts'],
      ['note_links', 'note_id', 'notes'],
    ] as const) {
      const result = await repairForeignKeyColumn(projectId, table, column, target)
      expect({ table, column, success: result.success, message: result.message }).toMatchObject({ table, column, success: true })
    }
    expect(await foreignKeysOf('orders')).toEqual(['user_id'])
    expect(await foreignKeysOf('reviews')).toEqual(['post_id'])
    expect(await foreignKeysOf('note_links')).toEqual(['note_id'])
  })

  test('is no longer offered once its key exists', async () => {
    expect(await detectFkColumnsMissingConstraints(projectId)).toEqual([])
  })
})
