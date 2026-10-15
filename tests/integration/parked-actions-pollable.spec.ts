/**
 * A parked executor action has an id the agent can poll
 * (medium finding AUT-05).
 *
 * The chat door parked medium/high executor actions as Review Queue
 * findings with NO id in the refusal, and check_approval read only
 * agentApprovalRequest rows — so from the agent's point of view the action
 * simply vanished: nothing to poll, nothing to report to the human. The
 * refusal now carries the finding id, and check_approval resolves parked
 * findings alongside destructive-gate approvals with the same status
 * vocabulary.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { getParkedActionForProject } from '@/lib/mcp/approvals'

const ROOT = process.cwd()

// Parking seals the action's params with a key derived from JWT_SECRET, and the
// sealer refuses anything under 32 characters. CI's secret is shorter, which
// made the park fail before a finding existed.
const savedJwtSecret = process.env.JWT_SECRET
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex')
}

let ownerId: string
let projectId: string

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `parked-poll-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Parked Poll Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'parked-poll', userId: ownerId },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.backendEvent?.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  if (savedJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = savedJwtSecret
}, 60_000)

describe('AUT-05: the parked refusal carries a pollable id', () => {
  let findingId: string

  it('a medium-risk action parks WITH its finding id and the poll call', async () => {
    const out = await executeAction(
      { action: 'SET_ENV_VAR', params: { key: 'WELCOME_SUBJECT', value: 'hi' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(out.success).toBe(false)
    expect(out.error).toBe('APPROVAL_REQUIRED')
    findingId = (out.data as any)?.findingId
    expect(typeof findingId).toBe('string')
    expect(out.message).toContain(findingId)
    expect(out.message).toContain('check_approval')
  }, 60_000)

  it('check_approval resolves the parked finding as pending', async () => {
    const view = await getParkedActionForProject(projectId, findingId)
    expect(view).toMatchObject({ kind: 'parked_action', status: 'pending', tool: 'SET_ENV_VAR' })
  }, 60_000)

  it('the owner approving or dismissing shows through the same vocabulary', async () => {
    await prisma.healthFinding.update({ where: { id: findingId }, data: { status: 'applied' } })
    await expect(getParkedActionForProject(projectId, findingId)).resolves.toMatchObject({ status: 'executed' })
    await prisma.healthFinding.update({ where: { id: findingId }, data: { status: 'dismissed' } })
    await expect(getParkedActionForProject(projectId, findingId)).resolves.toMatchObject({ status: 'rejected' })
  }, 60_000)

  it("another project's finding does not resolve (no cross-tenant oracle)", async () => {
    const other = await prisma.project.create({ data: { name: 'parked-other', userId: ownerId }, select: { id: true } })
    try {
      await expect(getParkedActionForProject(other.id, findingId)).resolves.toBeNull()
    } finally {
      await prisma.project.delete({ where: { id: other.id } }).catch(() => {})
    }
  }, 60_000)

  it('the MCP door consults both sources', () => {
    const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'mcp', 'tool', 'route.ts'), 'utf8')
    expect(route).toContain('getParkedActionForProject')
  })
})
