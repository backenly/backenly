/**
 * Calls a coding agent parked for approval are counted where the owner and
 * the agent look (medium findings OV-1, AUT-07, AUT-08).
 *
 * Two queues wait on a human: findings the autonomy loop holds, and calls an
 * agent parked in agent_approval_requests. The health summary behind the
 * Overview and the top bar, and the autonomy status tool, counted only the
 * first, and nothing announced the second, so a parked deploy or drop sat in
 * the Review Queue unseen until it expired. Now:
 *   - /health answers agentApprovalsPending beside needsAttention, which
 *     still counts held findings only (open findings = actionableTotal -
 *     needsAttention);
 *   - get_autonomy_status counts and names both queues, as the briefing does;
 *   - creating a request notifies the project's owner.
 * Expired requests count nowhere. Real approval, finding and notification rows;
 * the project-access check on the route is delegated (pinned elsewhere).
 */

let currentProjectId = ''
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) =>
    handler({ projectId: currentProjectId, userId: 'test-user' }),
}))

import '../helpers/real-web-standard'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createApprovalRequest } from '@/lib/mcp/approvals'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { GET as healthGET } from '@/app/api/projects/[id]/health/route'

const originalEdition = process.env.BACKENLY_EDITION
let ownerId = ''
let projectId = ''
let parkedId = ''

const call = (tool: string, args: Record<string, unknown> = {}) =>
  dispatchTool(tool as any, args, { projectId, userId: ownerId, createdThisTurn: new Set<string>() } as any)

async function healthSummary() {
  const res = await healthGET(new NextRequest(`http://localhost:3000/api/projects/${projectId}/health`), {
    params: Promise.resolve({ id: projectId }),
  } as any)
  return (await res.json()) as any
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  ownerId = (
    await prisma.user.create({
      data: { email: `parked-${randomUUID()}@test.invalid`, name: 'Parked Approvals Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({ data: { name: 'parked-approvals', userId: ownerId }, select: { id: true } })
  ).id
  currentProjectId = projectId

  // One held finding of the loop's own, so the two queues can be told apart.
  await prisma.healthFinding.create({
    data: { projectId, type: 'missing_index', severity: 'warning', status: 'pending_approval', details: {} },
  })
  // One live parked call, through the real path an agent's call takes.
  parkedId = (
    await createApprovalRequest({
      projectId,
      userId: ownerId,
      message: 'drop the orders table',
      danger: { tool: 'drop_table', target: 'orders', rowCount: 12, reversible: false },
      toolArgs: { tableName: 'orders' },
    })
  ).id
  // And one that expired, which must count nowhere.
  await prisma.agentApprovalRequest.create({
    data: {
      projectId, userId: ownerId, message: 'old', tool: 'drop_table', target: 'carts',
      rowCount: null, reversible: false, toolArgs: { tableName: 'carts' },
      expiresAt: new Date(Date.now() - 60_000),
    },
  })
}, 60_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  resetSingleTenantCache()
  await prisma.platformNotification.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.agentApprovalRequest.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('OV-1, AUT-08: the health summary counts parked agent calls', () => {
  it('answers agentApprovalsPending, live requests only, and keeps needsAttention to findings', async () => {
    const body = await healthSummary()
    expect(body.success).toBe(true)
    expect(body.data.agentApprovalsPending).toBe(1)
    expect(body.data.needsAttention).toBe(1)
    expect(body.data.actionableTotal).toBe(1)
  }, 60_000)
})

describe('AUT-07: the autonomy status names both queues', () => {
  it('counts the parked call beside the held fix and returns it for check_approval', async () => {
    const out = await call('get_autonomy_status')
    expect(out.ok).toBe(true)
    expect(out.summary).toContain(
      'Awaiting approval: 2 (1 agent-requested operation in the Review Queue, 1 autonomy fix held)',
    )
    const agentApprovals = (out.data as any).agentApprovals
    expect(agentApprovals).toHaveLength(1)
    expect(agentApprovals[0]).toMatchObject({ id: parkedId, tool: 'drop_table', target: 'orders' })
  }, 60_000)

  it('agrees with the briefing, which already counted both', async () => {
    const out = await call('get_pending_incidents')
    expect(out.ok).toBe(true)
    expect(out.summary).toMatch(/2 waiting on you \(1 agent-requested operation in the Review Queue, 1 autonomy fix escalated\)/)
  }, 60_000)
})

describe('AUT-08: creating a request tells the owner', () => {
  it('notifies the project owner with the call, the target and the expiry, linking to the queue', async () => {
    // The notice is sent without holding the agent's answer, so it can land a
    // moment after createApprovalRequest returns.
    let note = null as Awaited<ReturnType<typeof prisma.platformNotification.findFirst>>
    for (let i = 0; i < 50 && !note; i++) {
      note = await prisma.platformNotification.findFirst({ where: { userId: ownerId, type: 'approval_requested' } })
      if (!note) await new Promise((r) => setTimeout(r, 100))
    }
    expect(note).not.toBeNull()
    expect(note!.title).toBe('Your agent is waiting for your approval in "parked-approvals"')
    expect(note!.body).toContain('It asked to run drop_table on orders.')
    expect(note!.body).toContain('expires')
    expect(note!.metadata).toMatchObject({
      projectId,
      approvalId: parkedId,
      tool: 'drop_table',
      target: 'orders',
      actionUrl: expect.stringMatching(new RegExp(`/app/projects/${projectId}/autonomy$`)),
    })
  }, 60_000)

  it('sends one notice per burst, and a new one once the owner has read the last', async () => {
    const notices = () => prisma.platformNotification.count({ where: { userId: ownerId, type: 'approval_requested' } })
    const park = (target: string) =>
      createApprovalRequest({
        projectId,
        userId: ownerId,
        message: `drop ${target}`,
        danger: { tool: 'drop_table', target, rowCount: 1, reversible: false },
        toolArgs: { tableName: target },
      })

    // A looping agent parks again while the first notice is unread: no new one.
    await park('carts_a')
    await park('carts_b')
    await new Promise((r) => setTimeout(r, 1_000))
    expect(await notices()).toBe(1)

    // The owner reads it; the next request is announced.
    await prisma.platformNotification.updateMany({
      where: { userId: ownerId, type: 'approval_requested' },
      data: { read: true, readAt: new Date() },
    })
    await park('carts_c')
    for (let i = 0; i < 50 && (await notices()) < 2; i++) await new Promise((r) => setTimeout(r, 100))
    expect(await notices()).toBe(2)
  }, 60_000)
})
