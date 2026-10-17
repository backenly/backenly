/**
 * The missing-RLS detector leaves alone a table its owner opened on purpose.
 *
 * The all-access template turns a table's RLS off and records the choice as
 * the policy `backenly_all_access`. detectMissingRls flagged every table with
 * RLS off, so autonomy read that choice as a gap. It now skips a table while
 * all-access is its latest Backenly template, as reconcileAutoRls does; a later
 * template outranks it.
 *
 * Real database and the real template installer (applyPermissionPolicy).
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { detectMissingRls, tablesOwnerOpened } from '@/lib/services/workspace-observer'
import { applyPermissionPolicy } from '@/lib/services/workspace-rls'

let userId: string
let projectId: string
let schema: string

const flagged = async () =>
  (await detectMissingRls(projectId)).map((f) => (f.details as { tableName: string }).tableName).sort()

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `rls-owner-choice-${Date.now()}@example.test`, password: 'x', name: 'rls owner choice' },
  })
  userId = user.id
  projectId = (await prisma.project.create({ data: { name: 'rls-owner-choice-test', userId } })).id
  schema = `workspace_${projectId}`

  const raw = (sql: string) => prisma.$executeRawUnsafe(sql)
  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."users" (id uuid primary key default gen_random_uuid(), email text)`)
  await raw(`CREATE TABLE "${schema}"."posts" (id serial primary key, user_id uuid REFERENCES "${schema}"."users"(id), title text)`)
  await raw(`CREATE TABLE "${schema}"."widgets" (id serial primary key, label text)`)
  await raw(`GRANT USAGE ON SCHEMA "${schema}" TO authenticated`).catch(() => {})
  await raw(`GRANT SELECT ON "${schema}"."posts", "${schema}"."widgets" TO authenticated`).catch(() => {})
}, 60_000)

afterAll(async () => {
  await prisma.permissionPolicy.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe("an owner's recorded RLS choice", () => {
  test('both open tables are flagged before anyone chose', async () => {
    expect(await flagged()).toEqual(['posts', 'widgets'])
  })

  test('a table set to all access is no longer flagged; an untouched open one still is', async () => {
    const result = await applyPermissionPolicy(projectId, { tableName: 'posts', template: 'all_access' } as any)
    expect(result.success).toBe(true)
    expect(await tablesOwnerOpened(projectId, ['posts', 'widgets'])).toEqual(new Set(['posts']))
    expect(await flagged()).toEqual(['widgets'])
  })

  test('a later template outranks all access: RLS turned off again by hand is flagged again', async () => {
    const result = await applyPermissionPolicy(projectId, { tableName: 'posts', template: 'own_rows', userIdColumn: 'user_id' } as any)
    expect(result.success).toBe(true)
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."posts" DISABLE ROW LEVEL SECURITY`)
    expect(await tablesOwnerOpened(projectId, ['posts'])).toEqual(new Set())
    expect(await flagged()).toEqual(['posts', 'widgets'])
  })
})
