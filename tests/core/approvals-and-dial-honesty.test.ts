/**
 * The autonomy dial and the approval ledger stay truthful under failure
 * (medium findings AUT-04, AUT-06, AUT-09, BR-03).
 *
 * AUT-04: getProjectAutonomyLevel wrapped both reads in one try/catch whose
 * catch returned AGGRESSIVE — so a Subscription read failure overrode a dial
 * it had already read, opting an OFF/CONSERVATIVE owner back in.
 *
 * AUT-09: 'approved' is the moment between the human's click and the outcome.
 * If execution dies (restart mid-run), the terminal update never runs and the
 * row read 'approved' forever while check_approval told the agent to keep
 * polling and the queue showed nothing.
 *
 * AUT-06 / BR-03 are copy/surface pins: Review-only must not claim every
 * change waits (CONSERVATIVE auto-applies Tier-0), and the approval card must
 * let the human read the full statements a merge will apply.
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { getProjectAutonomyLevel } from '@/lib/autonomy/autonomy-level'
import { getApprovalForProject, listApprovals } from '@/lib/mcp/approvals'

const ROOT = process.cwd()

async function seedProject(autonomyLevel?: string) {
  const userId = randomUUID()
  const projectId = randomUUID()
  await prisma.user.create({
    data: {
      id: userId,
      email: `dial-honesty+${userId.slice(0, 8)}@backenly.test`,
      name: 'dial honesty fixture',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({
    data: { id: projectId, name: 'dial-honesty', userId, ...(autonomyLevel ? { autonomyLevel } : {}) } as any,
  })
  return { userId, projectId }
}

async function cleanup(projectId: string, userId: string) {
  await prisma.agentApprovalRequest.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
}

describe('AUT-04: a billing blip never widens the dial', () => {
  it('OFF survives a Subscription read failure', async () => {
    const { userId, projectId } = await seedProject('OFF')
    // Fault injection on ONE call: everything else in this suite runs against
    // the real test database. The catch path cannot be reached any other way.
    const spy = jest
      .spyOn(prisma.subscription, 'findFirst')
      .mockRejectedValueOnce(new Error('billing table unavailable'))
    try {
      await expect(getProjectAutonomyLevel(projectId)).resolves.toBe('OFF')
    } finally {
      spy.mockRestore()
      await cleanup(projectId, userId)
    }
  }, 60_000)

  it('CONSERVATIVE survives the same failure', async () => {
    const { userId, projectId } = await seedProject('CONSERVATIVE')
    const spy = jest
      .spyOn(prisma.subscription, 'findFirst')
      .mockRejectedValueOnce(new Error('billing table unavailable'))
    try {
      await expect(getProjectAutonomyLevel(projectId)).resolves.toBe('CONSERVATIVE')
    } finally {
      spy.mockRestore()
      await cleanup(projectId, userId)
    }
  }, 60_000)

  it('an unreadable project row still falls back to the product default', async () => {
    const spy = jest
      .spyOn(prisma.project, 'findUnique')
      .mockRejectedValueOnce(new Error('connection reset'))
    try {
      await expect(getProjectAutonomyLevel(randomUUID())).resolves.toBe('AGGRESSIVE')
    } finally {
      spy.mockRestore()
    }
  }, 60_000)
})

describe('AUT-09: a stuck approval stops lying', () => {
  it("an 'approved' row past the execute cap reads failed, with the unknown outcome named", async () => {
    const { userId, projectId } = await seedProject()
    const row = await prisma.agentApprovalRequest.create({
      data: {
        projectId,
        userId,
        message: 'Requested by an agent over MCP: drop the recipes table.',
        tool: 'drop_table',
        toolArgs: { tableName: 'recipes' },
        target: 'the `recipes` table',
        status: 'approved',
        decidedBy: userId,
        decidedAt: new Date(Date.now() - 15 * 60 * 1000), // cap is 10m + 2m grace
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })
    try {
      const view = await getApprovalForProject(projectId, row.id)
      expect(view?.status).toBe('failed')
      expect(view?.resultSummary ?? '').toMatch(/outcome is unknown/i)

      const listed = await listApprovals(projectId)
      const mine = listed.find((r) => r.id === row.id)
      expect(mine?.status).toBe('failed')
      expect(mine?.resultSummary ?? '').toMatch(/outcome is unknown/i)
    } finally {
      await cleanup(projectId, userId)
    }
  }, 60_000)

  it("a freshly approved row still reads 'approved' (it really is running)", async () => {
    const { userId, projectId } = await seedProject()
    const row = await prisma.agentApprovalRequest.create({
      data: {
        projectId,
        userId,
        message: 'Requested by an agent over MCP: drop the recipes table.',
        tool: 'drop_table',
        toolArgs: { tableName: 'recipes' },
        target: 'the `recipes` table',
        status: 'approved',
        decidedBy: userId,
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })
    try {
      const view = await getApprovalForProject(projectId, row.id)
      expect(view?.status).toBe('approved')
      expect(view?.resultSummary ?? null).toBeNull()
    } finally {
      await cleanup(projectId, userId)
    }
  }, 60_000)
})

describe('AUT-06: Review-only copy matches what CONSERVATIVE does', () => {
  // maxAutoTier(CONSERVATIVE) is 0: silent additive repairs (indexes, API
  // definitions) auto-apply. Copy claiming "every change waits" was false.
  it('the mode card no longer promises every change waits', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components', 'AutonomyGuardrailsSettings.tsx'), 'utf8')
    expect(src).not.toContain('Every change waits for your one-click approval.')
    expect(src).toContain('Silent additive repairs')
  })

  it('the findings panel names which rows auto-apply', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components', 'DetectedFindingsPanel.tsx'), 'utf8')
    expect(src).toContain('applies the silent additive ones')
  })

  it('the docs say visible changes, not every change', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'docs', 'content.ts'), 'utf8')
    expect(src).toContain('Review-only holds every visible change')
  })
})

describe('BR-03: the approval card shows what a merge applies', () => {
  it('describeDanger resolves branch name and statement count for merges', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'brain', 'agent.ts'), 'utf8')
    expect(src).toContain("case 'merge_branch':")
    expect(src).toContain("case 'discard_branch':")
    expect(src).toContain('merge of preview branch')
    expect(src).toContain('every unmerged change on it')
  })

  it('the queue card can expand to the full request text', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components', 'ReviewQueuePanel.tsx'), 'utf8')
    expect(src).toContain('Show the full request')
    expect(src).toContain('whitespace-pre-wrap')
  })

  it('the queue renders approved-but-unheard-from rows instead of hiding them', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components', 'ReviewQueuePanel.tsx'), 'utf8')
    expect(src).toContain("a.status === 'failed' && !a.executedAt")
    expect(src).toContain('AgentOutcomeRow')
  })
})
