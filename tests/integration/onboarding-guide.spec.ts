/**
 * The Getting Started guide, against a real database.
 *
 * tests/unit/onboarding-guide.spec.ts holds the rules. This holds the evidence:
 * that each step is read from the rows that really prove it, and from nothing
 * that merely looks like proof.
 *
 * The one that matters most is the connection step. The dashboard's own
 * "Test connection" button calls /api/mcp/health with the raw key, and that
 * authenticates, and stamps the key's lastUsed. If the guide read lastUsed it
 * would report "Connected" for a user who had never configured an agent. It
 * reads recorded calls instead, and the test below drives the real health
 * handler to prove the difference.
 *
 * Requests are hand-rolled for the same reason as mcp-oauth-flow.spec.ts:
 * jest.setup.js stubs Request/Response, so handlers get only what they read.
 */

import crypto from 'crypto'
import type { NextRequest } from 'next/server'

import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { recordMcpCall } from '@/lib/mcp/guard'
import { GET as mcpHealth } from '@/app/api/mcp/health/route'
import { collectGuideFacts, type VisibleProject } from '@/lib/onboarding/facts'
import { deriveGuide, GUIDE_INTRODUCED_AT, type GuideProgress, type StepId } from '@/lib/onboarding/guide'
import {
  claimStart,
  claimStepReport,
  dismissGuide,
  PreferenceUnavailableError,
  readPreference,
  reopenGuide,
} from '@/lib/onboarding/preference'
import { hideGuide, loadGuideState, showGuide } from '@/lib/onboarding/state'

const RUN = crypto.randomBytes(4).toString('hex')
const createdUsers: string[] = []

async function makeUser(label: string, createdAt?: Date) {
  const user = await prisma.user.create({
    data: {
      email: `guide-${label}-${RUN}@probe.local`,
      name: label,
      updatedAt: new Date(),
      ...(createdAt ? { createdAt } : {}),
    },
  })
  createdUsers.push(user.id)
  return user
}

async function makeProject(userId: string, name = 'guide probe', createdAt?: Date) {
  return prisma.project.create({
    data: { name, userId, updatedAt: new Date(), ...(createdAt ? { createdAt } : {}) },
  })
}

/** What POST /api/projects/[id]/mcp/keys writes, minus the audit row. */
async function mintMcpKey(userId: string, projectId: string) {
  const rawKey = `mcp_live_${crypto.randomBytes(32).toString('hex')}`
  const key = await prisma.apiKey.create({
    data: {
      name: 'MCP Key',
      keyHash: hashApiKey(rawKey),
      keyPrefix: rawKey.substring(0, 16),
      projectId,
      userId,
      permissions: ['read', 'write', 'admin'],
      rateLimit: 600,
      keyType: 'mcp',
      scope: 'mcp',
      serviceRole: true,
    },
  })
  return { rawKey, key }
}

/** recordMcpCall is fire-and-forget; wait for the row it writes. */
async function recordCall(key: { id: string; projectId: string | null }, userId: string, statusCode: number, tool = 'read_backend_state') {
  const before = await prisma.apiKeyUsage.count({ where: { apiKeyId: key.id } })
  recordMcpCall(
    { keyId: key.id, projectId: key.projectId!, userId, endpoint: '/api/mcp/tool', startedAt: Date.now() },
    { statusCode, tool, mutation: false, ...(statusCode >= 400 ? { error: 'refused in test' } : {}) },
  )
  for (let i = 0; i < 50; i++) {
    if ((await prisma.apiKeyUsage.count({ where: { apiKeyId: key.id } })) > before) return
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error('recordMcpCall did not write a usage row')
}

function visible(p: { id: string; name: string; createdAt: Date; projectStatus: string; deployedAt: Date | null }): VisibleProject {
  return { id: p.id, name: p.name, createdAt: p.createdAt, projectStatus: p.projectStatus, deployedAt: p.deployedAt }
}

async function progressOf(userId: string, projectId: string): Promise<GuideProgress> {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
  return deriveGuide(await collectGuideFacts(userId, [visible(p)]))
}

const statusOf = (g: GuideProgress, id: StepId) => g.steps.find((s) => s.id === id)!.status

const originalEdition = process.env.BACKENLY_EDITION

beforeAll(() => {
  // Cloud listing: the caller's own projects. Single-tenant would resolve THE
  // project, which a shared test database does not have.
  process.env.BACKENLY_EDITION = 'cloud'
})

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  await prisma.apiKey.deleteMany({ where: { userId: { in: createdUsers } } })
  await prisma.project.deleteMany({ where: { userId: { in: createdUsers } } })
  await prisma.userOnboarding.deleteMany({ where: { userId: { in: createdUsers } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } })
})

describe('the connection step reads recorded agent calls, and nothing else', () => {
  it('walks from key to connected on real rows', async () => {
    const user = await makeUser('connect')
    const project = await makeProject(user.id)

    let g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'project')).toBe('done')
    expect(statusOf(g, 'mcp_key')).toBe('todo')

    const { rawKey, key } = await mintMcpKey(user.id, project.id)
    g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'mcp_key')).toBe('done')
    expect(statusOf(g, 'agent')).toBe('waiting')

    // The dashboard's "Test connection": authenticates and stamps lastUsed.
    const res: any = await mcpHealth({
      headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? rawKey : null) },
    } as unknown as NextRequest)
    expect(res.status).toBe(200)
    for (let i = 0; i < 50; i++) {
      if ((await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsed) break
      await new Promise((r) => setTimeout(r, 40))
    }
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsed).not.toBeNull()

    g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'agent')).toBe('waiting')

    // A real tool call, written by the same function every MCP route uses.
    await recordCall(key, user.id, 200)
    g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'agent')).toBe('done')
    expect(g.focus?.lastAgentCallAt).not.toBeNull()
  })

  it('reports an agent whose calls are all failing, with the stored reason', async () => {
    const user = await makeUser('failing')
    const project = await makeProject(user.id)
    const { key } = await mintMcpKey(user.id, project.id)
    await recordCall(key, user.id, 403, 'apply_migration')

    const g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'agent')).toBe('failed')
    expect(g.failingCall).toMatchObject({ tool: 'apply_migration', statusCode: 403, error: 'refused in test' })
  })

  it("does not count someone else's key on the same project", async () => {
    const owner = await makeUser('owner')
    const other = await makeUser('other')
    const project = await makeProject(owner.id)
    const { key } = await mintMcpKey(other.id, project.id)
    await recordCall(key, other.id, 200)

    const g = await progressOf(owner.id, project.id)
    expect(statusOf(g, 'mcp_key')).toBe('todo')
    expect(statusOf(g, 'agent')).toBe('todo')
  })

  it('goes back to "generate a key" when the only key is revoked', async () => {
    const user = await makeUser('revoked')
    const project = await makeProject(user.id)
    const { key } = await mintMcpKey(user.id, project.id)
    await recordCall(key, user.id, 200)
    expect(statusOf(await progressOf(user.id, project.id), 'agent')).toBe('done')

    // What DELETE /api/projects/[id]/mcp/keys/[keyId] does.
    await prisma.apiKey.delete({ where: { id: key.id } })
    const g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'mcp_key')).toBe('todo')
    expect(statusOf(g, 'agent')).toBe('todo')
  })
})

describe('built, published, watched', () => {
  it('reads each from the row that proves it', async () => {
    const user = await makeUser('lifecycle')
    const project = await makeProject(user.id)

    // A lone `users` table is auth plumbing, not something built.
    await prisma.table.create({ data: { name: 'users', projectId: project.id } })
    let g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'backend')).toBe('todo')
    expect(statusOf(g, 'watching')).toBe('todo')

    await prisma.table.create({ data: { name: 'notes', projectId: project.id } })
    g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'backend')).toBe('done')
    expect(statusOf(g, 'watching')).toBe('waiting')

    await prisma.project.update({
      where: { id: project.id },
      data: { projectStatus: 'FAILED', deploymentError: 'Readiness check failed' },
    })
    g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'publish')).toBe('failed')
    expect(g.focus?.deploymentError).toBe('Readiness check failed')

    await prisma.project.update({
      where: { id: project.id },
      data: { projectStatus: 'LIVE', deployedAt: new Date(), deploymentError: null },
    })
    expect(statusOf(await progressOf(user.id, project.id), 'publish')).toBe('done')

    // The reconciler's own clock: an AUTONOMY_TICK audit row.
    await prisma.auditLog.create({
      data: { projectId: project.id, action: 'AUTONOMY_TICK', type: 'autonomy', details: '{}' },
    })
    g = await progressOf(user.id, project.id)
    expect(statusOf(g, 'watching')).toBe('done')
    expect(g.focus?.lastCheckedAt).not.toBeNull()
  })

  it('counts an observer scan as a check too', async () => {
    const user = await makeUser('observed')
    const project = await makeProject(user.id)
    await prisma.table.create({ data: { name: 'posts', projectId: project.id } })
    await prisma.project.update({ where: { id: project.id }, data: { lastObservedAt: new Date() } })
    expect(statusOf(await progressOf(user.id, project.id), 'watching')).toBe('done')
  })
})

describe('the stored preference', () => {
  it('starts empty, hides, reopens', async () => {
    const user = await makeUser('pref')
    expect(await readPreference(user.id)).toMatchObject({ available: true, exists: false, dismissedAt: null })

    await dismissGuide(user.id)
    expect((await readPreference(user.id)).dismissedAt).not.toBeNull()

    await reopenGuide(user.id)
    const pref = await readPreference(user.id)
    expect(pref.dismissedAt).toBeNull()
    expect(pref.reopenedAt).not.toBeNull()
  })

  it('claims the start and each step exactly once', async () => {
    const user = await makeUser('claims')
    const starts = await Promise.all([claimStart(user.id), claimStart(user.id)])
    // Both may create the row; only one may set startedAt.
    expect(starts.filter(Boolean)).toHaveLength(1)

    const reports = await Promise.all([claimStepReport(user.id, 'project'), claimStepReport(user.id, 'project')])
    expect(reports.filter(Boolean)).toHaveLength(1)
    expect(await claimStepReport(user.id, 'mcp_key')).toBe(true)
    expect((await readPreference(user.id)).reportedSteps.sort()).toEqual(['mcp_key', 'project'])
  })
})

describe('loadGuideState', () => {
  const beforeGuide = new Date(Date.parse(GUIDE_INTRODUCED_AT) - 30 * 86_400_000)

  it('shows a new account its progress, and records each milestone once', async () => {
    const user = await makeUser('new-account')
    const project = await makeProject(user.id)
    await mintMcpKey(user.id, project.id)

    const caller = { userId: user.id, createdAt: user.createdAt }
    const first = await loadGuideState(caller)
    expect(first.visible).toBe(true)
    expect(first.audience).toBe('new')
    expect(first.savable).toBe(true)
    expect(first.progress?.currentStepId).toBe('agent')

    const pref = await readPreference(user.id)
    expect(pref.startedAt).not.toBeNull()
    expect(pref.reportedSteps.sort()).toEqual(['mcp_key', 'project'])

    await loadGuideState(caller)
    expect((await readPreference(user.id)).reportedSteps).toHaveLength(2)
  })

  it('shows nothing to an account that had a project before the guide, until it is reopened', async () => {
    const user = await makeUser('existing', beforeGuide)
    await makeProject(user.id, 'older project', beforeGuide)
    const caller = { userId: user.id, createdAt: user.createdAt }

    const state = await loadGuideState(caller)
    expect(state).toMatchObject({ visible: false, audience: 'existing', progress: null })
    expect((await readPreference(user.id)).exists).toBe(false)

    const reopened = await showGuide(caller)
    expect(reopened.visible).toBe(true)
    expect(reopened.progress?.steps.find((s) => s.id === 'project')?.status).toBe('done')
  })

  it('stays hidden once hidden, across reads', async () => {
    const user = await makeUser('hider')
    const caller = { userId: user.id, createdAt: user.createdAt }
    expect((await loadGuideState(caller)).visible).toBe(true)

    const hidden = await hideGuide(caller)
    expect(hidden).toMatchObject({ visible: false, progress: null })
    expect((await loadGuideState(caller)).visible).toBe(false)
  })

  it('an account with no project is shown the first step', async () => {
    const user = await makeUser('empty')
    const state = await loadGuideState({ userId: user.id, createdAt: user.createdAt })
    expect(state.progress).toMatchObject({ completed: 1, currentStepId: 'project', focus: null })
  })
})

describe('before the migration has run', () => {
  // A release can reach a server ahead of its migration. In that window the
  // guide must not take /app down with it: reads fall back to "nothing stored",
  // and a hide that cannot be saved says so instead of throwing a 500.
  it('degrades to nothing stored, and refuses to pretend a hide was saved', async () => {
    const user = await makeUser('premigration')
    await prisma.$executeRawUnsafe('ALTER TABLE "user_onboarding" RENAME TO "user_onboarding_hidden_by_test"')
    try {
      expect(await readPreference(user.id)).toMatchObject({ available: false, exists: false })
      await expect(dismissGuide(user.id)).rejects.toBeInstanceOf(PreferenceUnavailableError)

      const state = await loadGuideState({ userId: user.id, createdAt: user.createdAt })
      expect(state).toMatchObject({ visible: true, savable: false })
      expect(state.progress?.currentStepId).toBe('project')
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "user_onboarding_hidden_by_test" RENAME TO "user_onboarding"')
    }
  })
})
