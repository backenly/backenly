/**
 * AN APPROVED MERGE RUNS EXACTLY WHAT THE HUMAN READ
 * ==================================================
 * The approvals contract (lib/mcp/approvals.ts) promises "what executes is
 * exactly what the human read". The parked merge broke it: the card's text was
 * built from the branch's migration log at PARK time, but the replay read the
 * log again at EXECUTION time — and the log kept accepting statements while
 * the request sat in the queue. An agent could park an innocent one-statement
 * merge and append anything it liked before the click.
 *
 * Pinned here against real branch rows and the real engine:
 *
 *   - a merge pinned to the approved statements REFUSES with MERGE_STALE when
 *     the log has grown, and the branch stays active
 *   - the same pin passes when the log still matches
 *   - a console merge (no pin) keeps its live-diff semantics
 *   - end to end: an approval parked with the pinned list, decided after the
 *     log grew, records the refusal instead of running unread DDL
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { mergeBranch } from '@/lib/branches/engine'
import { createApprovalRequest, decideApproval } from '@/lib/mcp/approvals'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const STMT_1 = 'CREATE TABLE "widgets" (id integer primary key)'
const STMT_2 = 'ALTER TABLE "widgets" ADD COLUMN sneaky text'

const createdUserIds: string[] = []
const createdProjectIds: string[] = []
let ownerId = ''
let projectId = ''

async function makeBranch(name: string): Promise<string> {
  const schemaName = `workspace_${projectId}_br_${name}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  const b = await prisma.workspaceBranch.create({
    data: { projectId, name, schemaName, status: 'active', createdBy: ownerId },
    select: { id: true },
  })
  await prisma.workspaceBranchMigration.create({
    data: { branchId: b.id, seq: 1, statements: [STMT_1], appliedBy: ownerId },
  })
  return b.id
}

const growLog = (branchId: string) =>
  prisma.workspaceBranchMigration.create({
    data: { branchId, seq: 2, statements: [STMT_2], appliedBy: ownerId },
  })

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

beforeAll(async () => {
  assertSafeTestDatabase()
  process.env.BACKENLY_EDITION = 'cloud'
  const u = await prisma.user.create({
    data: { email: `maf-${randomUUID()}@test.invalid`, name: 'Merge Freeze Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  ownerId = u.id
  const p = await prisma.project.create({
    data: { name: `maf-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
})

afterAll(async () => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } })
  for (const b of branches) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  }
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.workspaceBranchMigration.deleteMany({ where: { branch: { projectId } } })
  await prisma.workspaceBranch.deleteMany({ where: { projectId } })
  await prisma.agentApprovalRequest.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
})

describe('the pinned merge', () => {
  it('refuses with MERGE_STALE when the log grew after approval, and the branch stays active', async () => {
    const branchId = await makeBranch('stale')
    await growLog(branchId)

    const res: any = await mergeBranch(projectId, ownerId, branchId, [STMT_1])

    expect(res.ok).toBe(false)
    expect(res.code).toBe('MERGE_STALE')
    expect(res.error).toContain('approved 1 statement(s)')
    expect(res.error).toContain('Nothing was applied')
    const branch = await prisma.workspaceBranch.findUnique({ where: { id: branchId }, select: { status: true } })
    expect(branch?.status).toBe('active')
  })

  it('passes when the log still matches what was approved', async () => {
    const branchId = await makeBranch('fresh')

    const res: any = await mergeBranch(projectId, ownerId, branchId, [STMT_1])

    expect(res.code).not.toBe('MERGE_STALE')
    expect(res.ok).toBe(true)
  })

  it('a console merge without a pin keeps live-diff semantics', async () => {
    const branchId = await makeBranch('livediff')
    await growLog(branchId)

    const res: any = await mergeBranch(projectId, ownerId, branchId)

    expect(res.code).not.toBe('MERGE_STALE')
  })
})

describe('end to end through the approval queue', () => {
  it('an approval decided after the log grew records the refusal, not unread DDL', async () => {
    const branchId = await makeBranch('queued')

    const row = await createApprovalRequest({
      projectId,
      userId: ownerId,
      message: `Merge preview branch "queued" into production. These statements will be applied:\n  ${STMT_1}`,
      danger: { tool: 'merge_branch', target: 'merge queued', rowCount: null, reversible: false },
      toolArgs: { branchId, approvedMigrations: [STMT_1] },
    })

    // The agent appends while the request sits in the queue.
    await growLog(branchId)

    const decided = await decideApproval({
      projectId,
      approvalId: row.id,
      approverUserId: ownerId,
      decision: 'approve',
    })

    expect(decided.status).toBe('failed')
    expect(String(decided.resultSummary)).toContain('log changed after the merge was approved')
    expect(String(decided.resultSummary)).toContain('Nothing was applied')
    const branch = await prisma.workspaceBranch.findUnique({ where: { id: branchId }, select: { status: true } })
    expect(branch?.status).toBe('active')
  })
})
