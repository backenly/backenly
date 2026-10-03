/**
 * SCHEMA HISTORY WAS READABLE AND ROLLBACK-ABLE ACROSS TENANTS
 * ===========================================================
 * `/api/projects/[id]/schema-versions` called `verifyToken` and stopped. That
 * proves the caller is SOME signed-in user and says nothing about whether the
 * project in the URL is theirs. The id came straight from the path, so any
 * authenticated account could read another tenant's full schema snapshots —
 * and, through POST, **roll back another tenant's schema**. One request, and
 * the destructive half needed no more privilege than the read.
 *
 * It had no UI, which is why nothing noticed. It was found while building one.
 *
 * Underneath the route there was a second, independent hole: `getSchemaVersion`
 * was a `findUnique` on the version id alone, and it stripped `projectId` from
 * what it returned — so no caller could have checked ownership even if it had
 * tried. `rollbackToVersion` used it, which meant a caller could roll THEIR OWN
 * project back to another tenant's snapshot: destroying their schema with a
 * shape it never had, and disclosing the other tenant's structure on the way.
 *
 * These tests are at the library boundary, because that is where the fix is.
 * Scoping the query makes the bug unrepresentable rather than relying on every
 * caller to remember a check, and a route-level test would pass against a
 * library that was still willing.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { getSchemaVersion, rollbackToVersion } from '@/lib/versioning/schema-versions'

let userId: string
let victimUserId: string
let projectId: string
let victimProjectId: string
let victimVersionId: string
let ownVersionId: string

beforeAll(async () => {
  const attacker = await prisma.user.create({
    data: { email: `sv-attacker-${Date.now()}@example.test`, password: 'x', name: 'attacker' },
  })
  userId = attacker.id
  const victim = await prisma.user.create({
    data: { email: `sv-victim-${Date.now()}@example.test`, password: 'x', name: 'victim' },
  })
  victimUserId = victim.id

  const mine = await prisma.project.create({ data: { name: 'sv-mine', userId } })
  projectId = mine.id
  const theirs = await prisma.project.create({ data: { name: 'sv-theirs', userId: victimUserId } })
  victimProjectId = theirs.id

  // A snapshot in each project. Written directly: what is under test is the
  // lookup, not how snapshots come to exist.
  const ownVersion = await prisma.schemaVersion.create({
    data: {
      projectId,
      versionNum: 1,
      snapshot: { tables: [] },
      description: 'mine',
      triggeredBy: 'test',
    },
  })
  ownVersionId = ownVersion.id

  const victimVersion = await prisma.schemaVersion.create({
    data: {
      projectId: victimProjectId,
      versionNum: 1,
      // Real structure, so a leak would be worth something.
      snapshot: { tables: [{ name: 'billing_secrets', columns: [{ name: 'card', type: 'text' }] }] },
      description: 'theirs',
      triggeredBy: 'test',
    },
  })
  victimVersionId = victimVersion.id
}, 120_000)

afterAll(async () => {
  await prisma.schemaVersion.deleteMany({ where: { projectId: { in: [projectId, victimProjectId] } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [projectId, victimProjectId] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [userId, victimUserId] } } }).catch(() => {})
}, 60_000)

describe('reading a snapshot', () => {
  test('returns a version that belongs to the project', async () => {
    // The positive case first: without it, every refusal below could pass
    // because the lookup was simply broken.
    const v = await getSchemaVersion(ownVersionId, projectId)
    expect(v).not.toBeNull()
    expect(v!.description).toBe('mine')
  })

  test('refuses a version belonging to another project', async () => {
    // THE test. Holding a valid version id is not authorisation: it lives in a
    // different namespace than the project id, so the two have to be matched.
    const v = await getSchemaVersion(victimVersionId, projectId)
    expect(v).toBeNull()
  })

  test('the victim snapshot really exists and is readable in its own project', async () => {
    // Guards the guard. If the row were missing, the refusal above would pass
    // while testing nothing at all.
    const v = await getSchemaVersion(victimVersionId, victimProjectId)
    expect(v).not.toBeNull()
    expect((v!.snapshot as any).tables[0].name).toBe('billing_secrets')
  })
})

describe('rolling back', () => {
  test('refuses a target version owned by another project', async () => {
    // The destructive half. Before the fix this would have proceeded to
    // compute a diff against another tenant's schema and execute DDL.
    const r = await rollbackToVersion(projectId, victimVersionId)
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/not found/i)
    expect(r.statementsExecuted).toEqual([])
  }, 60_000)

  test('a refused rollback executes no statements at all', async () => {
    // Not merely "returned false". A partial rollback that reported failure
    // would still have changed the schema.
    const r = await rollbackToVersion(projectId, victimVersionId)
    expect(r.statementsExecuted).toHaveLength(0)

    // And it did not leave a pre-rollback snapshot behind, which would mean it
    // got far enough to start.
    const mine = await prisma.schemaVersion.count({ where: { projectId } })
    expect(mine).toBe(1)
  }, 60_000)

  test('refuses a version id that does not exist at all', async () => {
    const r = await rollbackToVersion(projectId, '00000000-0000-0000-0000-000000000000')
    expect(r.success).toBe(false)
    expect(r.statementsExecuted).toEqual([])
  }, 60_000)
})
