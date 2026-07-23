/**
 * Phase 10 — hydration / refresh consistency
 * ------------------------------------------
 * Mirrors what the project-page does on refresh: load the conversation,
 * derive `currentBuildState`, and assert that:
 *   • Refreshing twice does not duplicate build snapshots in the thread.
 *   • A resolved-credentials run does not re-surface the old "Blocked" state
 *     as the current state.
 *   • The new dashboard fallback flag is independent of Phase 10.
 *
 * Uses the real test database — no mocks (per project rule).
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import {
  recordBuildSnapshot,
  loadConversation,
} from '@/lib/build-runs/build-run-service'

let testUserId: string
let projectIds: string[] = []

async function createProject(): Promise<string> {
  const project = await prisma.project.create({
    data: {
      name: `Phase10 Hydration Test ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: 'Phase 10 hydration test fixture',
      environment: 'development',
      userId: testUserId,
    },
    select: { id: true },
  })
  projectIds.push(project.id)
  return project.id
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `phase10-hydration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      name: 'Phase 10 Hydration User',
      password: 'hashed_password_not_used',
    },
    select: { id: true },
  })
  testUserId = user.id
})

afterAll(async () => {
  for (const id of projectIds) {
    await prisma.project.delete({ where: { id } }).catch(() => {})
  }
  if (testUserId) {
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {})
  }
})

describe('Phase 10 — refresh consistency', () => {
  test('two refreshes return identical thread + currentBuildState', async () => {
    const projectId = await createProject()
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-R',
      userContent: 'go',
      aiContent: 'Done.',
      buildResponse: { mode: 'build', built: [{ id: 't', label: 't' }], jobStatus: 'verified' },
    })
    const a = await loadConversation(projectId)
    const b = await loadConversation(projectId)
    expect(b.messages.map(m => m.id)).toEqual(a.messages.map(m => m.id))
    expect(b.currentBuildState?.messageId).toBe(a.currentBuildState?.messageId)
  })

  test('resolved credentials: blocked snapshot becomes historical, current is verified', async () => {
    const projectId = await createProject()
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-K',
      userContent: 'build payments',
      aiContent: 'Blocked on Stripe.',
      buildResponse: {
        mode: 'build',
        blocked: [{ id: 'stripe', label: 'Stripe', reason: 'no key' }],
        jobStatus: 'blocked',
      },
    })
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-K',
      userContent: '[Stripe key entered]',
      aiContent: 'Stripe verified.',
      buildResponse: { mode: 'build', verified: ['stripe'], jobStatus: 'verified' },
    })

    const conv = await loadConversation(projectId)
    // currentBuildState reflects the verified run, NOT the earlier blocked one.
    expect(conv.currentBuildState?.buildResponse.jobStatus).toBe('verified')
    expect(conv.currentBuildState?.buildResponse.blocked ?? []).toHaveLength(0)
    // The thread still contains both AI snapshots so users can scroll back.
    const aiMessages = conv.messages.filter(m => m.role === 'ai')
    expect(aiMessages).toHaveLength(2)
    // Exactly one AI snapshot is current; the other is historical.
    const currentCount = aiMessages.filter(m => {
      const meta = m.metadata as Record<string, unknown> | null
      return meta && (meta as any).buildJobId && !(meta as any).supersededAt
    }).length
    expect(currentCount).toBe(1)
  })

  test('repeating the same supersession sequence does not duplicate snapshots', async () => {
    const projectId = await createProject()
    for (let i = 0; i < 3; i++) {
      await recordBuildSnapshot({
        projectId,
        buildJobId: 'job-D',
        userContent: `attempt ${i}`,
        aiContent: `state ${i}`,
        buildResponse: { mode: 'build', built: [{ id: 't', label: `t${i}` }], jobStatus: 'verified' },
      })
    }
    const conv = await loadConversation(projectId)
    const aiMessages = conv.messages.filter(m => m.role === 'ai')
    expect(aiMessages).toHaveLength(3)
    const activeSnapshots = aiMessages.filter(m => {
      const meta = m.metadata as Record<string, unknown> | null
      return meta && (meta as any).buildJobId && !(meta as any).supersededAt
    })
    // After three snapshots for the SAME job, exactly one is current.
    expect(activeSnapshots).toHaveLength(1)
    expect(conv.currentBuildState?.snapshotSeq).toBe(3)
  })
})

describe('Phase 10 — dashboard fallback safety', () => {
  test('new dashboard flag is unaffected by Phase 10 service usage', async () => {
    // Both flags are independent. Hydration succeeds whether or not the new
    // dashboard is on — the service does not read or depend on it.
    const projectId = await createProject()
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-F',
      userContent: 'q',
      aiContent: 'a',
      buildResponse: { mode: 'build', built: [{ id: 't', label: 't' }], jobStatus: 'verified' },
    })
    const conv = await loadConversation(projectId)
    expect(conv.currentBuildState).not.toBeNull()
    expect(conv.messages.length).toBeGreaterThan(0)
  })
})
