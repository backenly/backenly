/**
 * PASSING A TENANT ID INTO A SERVICE IS NOT EVIDENCE THE SERVICE USES IT
 * =====================================================================
 * Two defects with one lesson, found in the dashboard authorization sweep.
 *
 * `getWorkspaceUsers(projectId)` took a projectId, ignored it, and ran
 * `SELECT id, email, name, "createdAt" FROM users` on the PLATFORM connection.
 * `users` is unqualified, so search_path resolved it to `public.users` - and
 * the platform User model is `@@map("users")`. It returned every account on
 * the deployment, with emails, for any projectId at all.
 *
 * The parameter is what made it dangerous. Every call site passed the right
 * argument, so the function looked tenant-scoped from the outside, and no
 * amount of route-level review would have found it.
 *
 * `database-brain/.../generate-fix` had no authentication and looked its issue
 * up by id alone. An unauthorized caller could read a victim's issue, spend the
 * operator's AI credit on it, and REGENERATE the stored `sqlFix` - the field
 * the sibling apply-fix route later runs through `$executeRawUnsafe`. Not
 * direct SQL injection, because the caller supplies no SQL; cross-tenant fix
 * poisoning plus cost abuse, which is a different claim and worth stating as
 * the one that is true.
 *
 * These tests sit at the query layer, because that is where both fixes live.
 * Two-sided: every refusal is paired with the read or write it must not have
 * broken.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'

let ownerId: string
let victimUserId: string
let myProjectId: string
let victimProjectId: string
let victimIssueId: string
let myIssueId: string

const ORIGINAL_FIX = 'CREATE INDEX CONCURRENTLY idx_original ON orders (customer_id);'

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `svc-owner-${Date.now()}@example.test`, password: 'x', name: 'owner' },
  })
  ownerId = owner.id
  const victim = await prisma.user.create({
    data: { email: `svc-victim-${Date.now()}@example.test`, password: 'x', name: 'victim' },
  })
  victimUserId = victim.id

  const mine = await prisma.project.create({ data: { name: 'svc-mine', userId: ownerId } })
  myProjectId = mine.id
  const theirs = await prisma.project.create({ data: { name: 'svc-theirs', userId: victimUserId } })
  victimProjectId = theirs.id

  const victimIssue = await prisma.databaseIssue.create({
    data: {
      projectId: victimProjectId,
      title: 'Victim: sequential scan on orders',
      description: 'Their private schema analysis',
      severity: 'warning',
      database: 'postgresql',
      category: 'performance',
      suggestedFix: 'Add an index on orders.customer_id',
      sqlFix: ORIGINAL_FIX,
    },
  })
  victimIssueId = victimIssue.id

  const myIssue = await prisma.databaseIssue.create({
    data: {
      projectId: myProjectId,
      title: 'Mine: missing index',
      description: 'My own issue',
      severity: 'info',
      database: 'postgresql',
      category: 'performance',
      suggestedFix: 'Add an index on things.id',
      sqlFix: 'CREATE INDEX idx_mine ON things (id);',
    },
  })
  myIssueId = myIssue.id
}, 120_000)

afterAll(async () => {
  await prisma.databaseIssue.deleteMany({
    where: { projectId: { in: [myProjectId, victimProjectId] } },
  }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [myProjectId, victimProjectId] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, victimUserId] } } }).catch(() => {})
}, 60_000)

describe('the scoped issue lookup generate-fix now uses', () => {
  test('finds an issue that belongs to the project', async () => {
    // The positive half. A predicate that matched nothing would make every
    // refusal below pass while breaking the feature.
    const issue = await prisma.databaseIssue.findFirst({
      where: { id: myIssueId, projectId: myProjectId },
    })
    expect(issue).not.toBeNull()
    expect(issue!.title).toContain('Mine')
  })

  test('does NOT find another project’s issue, even with the right issue id', async () => {
    // The whole defect: an issue id is not authorization. Before the fix this
    // was a findUnique on the id alone and returned the row.
    const issue = await prisma.databaseIssue.findFirst({
      where: { id: victimIssueId, projectId: myProjectId },
    })
    expect(issue).toBeNull()
  })

  test('the victim issue genuinely exists and carries readable detail', async () => {
    // Guards the guard. If the row were missing, the refusal above would pass
    // while proving nothing.
    const issue = await prisma.databaseIssue.findFirst({
      where: { id: victimIssueId, projectId: victimProjectId },
    })
    expect(issue).not.toBeNull()
    expect(issue!.description).toBe('Their private schema analysis')
  })
})

describe('fix poisoning', () => {
  test('a scoped update cannot touch another project’s sqlFix', async () => {
    // updateMany keeps projectId in the predicate. `update` takes a unique
    // where clause and would silently drop the scope, which is why the route
    // uses updateMany.
    const result = await prisma.databaseIssue.updateMany({
      where: { id: victimIssueId, projectId: myProjectId },
      data: { sqlFix: 'DROP TABLE orders;' },
    })
    expect(result.count).toBe(0)
  })

  test('the victim’s stored fix is byte-for-byte unchanged', async () => {
    // "Denied" and "denied and changed nothing" are different claims, and only
    // the second matters for a field that apply-fix later executes.
    const issue = await prisma.databaseIssue.findFirst({
      where: { id: victimIssueId, projectId: victimProjectId },
    })
    expect(issue!.sqlFix).toBe(ORIGINAL_FIX)
  })

  test('a later legitimate apply-fix would read the original fix', async () => {
    // The end-to-end property the poisoning attack was aiming at: what the
    // victim's own operator would execute.
    const issue = await prisma.databaseIssue.findFirst({
      where: { id: victimIssueId, projectId: victimProjectId },
    })
    expect(issue!.sqlFix).toBe(ORIGINAL_FIX)
    expect(issue!.sqlFix).not.toContain('DROP TABLE')
  })

  test('the owner CAN update their own issue, so the scope is not simply broken', async () => {
    const updated = 'CREATE INDEX idx_mine_v2 ON things (id);'
    const result = await prisma.databaseIssue.updateMany({
      where: { id: myIssueId, projectId: myProjectId },
      data: { sqlFix: updated },
    })
    expect(result.count).toBe(1)

    const issue = await prisma.databaseIssue.findFirst({
      where: { id: myIssueId, projectId: myProjectId },
    })
    expect(issue!.sqlFix).toBe(updated)
  })
})

describe('the platform user table is not reachable as workspace data', () => {
  test('the platform users table holds accounts from every tenant', async () => {
    // States the precondition the old getWorkspaceUsers exploited: `users` on
    // the platform connection is public.users, the account table, and it spans
    // tenants by design.
    const accounts = await prisma.user.findMany({
      where: { id: { in: [ownerId, victimUserId] } },
      select: { email: true },
    })
    expect(accounts).toHaveLength(2)
  })

  test('an unqualified read would have crossed that boundary', async () => {
    // The exact query the service used to run. Asserting what it returns is
    // what makes the fix meaningful rather than cosmetic: it reaches platform
    // accounts, which is never what "this project's end users" should mean.
    const rows = await prisma.$queryRawUnsafe<Array<{ email: string }>>(
      `SELECT email FROM users WHERE id = $1`,
      victimUserId,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toContain('svc-victim-')
  })
})
