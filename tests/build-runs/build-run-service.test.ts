/**
 * Phase 10 — BuildRun service tests.
 *
 * Hits the real test database (per project rule: do NOT mock the DB). Each
 * test creates a throwaway User + Project, exercises the service, and cleans
 * up. ConversationMessage rows cascade with the Project on delete.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import {
  appendUserMessage,
  appendAiMessage,
  recordBuildSnapshot,
  loadConversation,
  clearConversation,
} from '@/lib/build-runs/build-run-service'

let testUserId: string
let projectIds: string[] = []

async function createProject(): Promise<string> {
  const project = await prisma.project.create({
    data: {
      name: `Phase10 BuildRun Test ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: 'Phase 10 conversation history test fixture',
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
      email: `phase10-buildrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
      name: 'Phase 10 Test User',
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

describe('Phase 10 — recordBuildSnapshot', () => {
  test('first snapshot is current; no prior messages to supersede', async () => {
    const projectId = await createProject()
    const result = await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-1',
      userContent: 'create users table',
      aiContent: 'Created users table.',
      buildResponse: { mode: 'build', built: [{ id: 'users', label: 'users' }], jobStatus: 'verified' },
    })
    expect(result.snapshotSeq).toBe(1)
    expect(result.supersededIds).toEqual([])
    const conv = await loadConversation(projectId)
    expect(conv.messages).toHaveLength(2) // user + AI
    expect(conv.currentBuildState?.buildJobId).toBe('job-1')
    expect(conv.currentBuildState?.snapshotSeq).toBe(1)
  })

  test('second snapshot for same job supersedes the first; only one is current', async () => {
    const projectId = await createProject()
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-A',
      userContent: 'build store',
      aiContent: 'Blocked on Stripe creds',
      buildResponse: {
        mode: 'build',
        built: [{ id: 'orders', label: 'orders' }],
        blocked: [{ id: 'stripe', label: 'Stripe', reason: 'no key', integrationId: 'stripe' }],
        jobStatus: 'blocked',
      },
    })
    const second = await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-A',
      userContent: '[Stripe key entered]',
      aiContent: 'All integrations connected.',
      buildResponse: {
        mode: 'build',
        built: [{ id: 'orders', label: 'orders' }, { id: 'stripe', label: 'Stripe' }],
        verified: ['stripe'],
        jobStatus: 'verified',
      },
    })
    expect(second.snapshotSeq).toBe(2)
    expect(second.supersededIds).toHaveLength(1)
    const conv = await loadConversation(projectId)
    // 2 user msgs + 2 AI snapshots
    expect(conv.messages).toHaveLength(4)
    // Only the second AI snapshot should be the current build state
    expect(conv.currentBuildState?.snapshotSeq).toBe(2)
    expect(conv.currentBuildState?.buildResponse.jobStatus).toBe('verified')
    // The first AI snapshot is still in the thread but tagged supersededAt
    const aiMessages = conv.messages.filter(m => m.role === 'ai')
    expect(aiMessages).toHaveLength(2)
    const olderMeta = aiMessages[0].metadata as Record<string, unknown>
    expect(typeof olderMeta.supersededAt).toBe('string')
    const newerMeta = aiMessages[1].metadata as Record<string, unknown>
    expect(newerMeta.supersededAt).toBeUndefined()
  })

  test('snapshots from different build jobs are tracked independently', async () => {
    const projectId = await createProject()
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-X',
      userContent: 'a',
      aiContent: 'A.',
      buildResponse: { mode: 'build', built: [{ id: 't1', label: 't1' }], jobStatus: 'verified' },
    })
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-Y',
      userContent: 'b',
      aiContent: 'B.',
      buildResponse: { mode: 'build', built: [{ id: 't2', label: 't2' }], jobStatus: 'verified' },
    })
    const conv = await loadConversation(projectId)
    // The latest non-superseded snapshot wins, but neither is superseded by the other
    expect(conv.currentBuildState?.buildJobId).toBe('job-Y')
    const aiMessages = conv.messages.filter(m => m.role === 'ai')
    expect(aiMessages).toHaveLength(2)
    for (const ai of aiMessages) {
      const meta = ai.metadata as Record<string, unknown>
      expect(meta.supersededAt).toBeUndefined()
    }
  })
})

describe('Phase 10 — loadConversation ordering', () => {
  test('messages are returned in chronological order regardless of insert ordering', async () => {
    const projectId = await createProject()
    // Insert a build snapshot first (creates user + AI rows)
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-O',
      userContent: 'first user msg',
      aiContent: 'first ai snapshot',
      buildResponse: { mode: 'build', built: [], jobStatus: 'verified' },
    })
    // Then a plain follow-up question
    await appendUserMessage(projectId, 'what tables exist?')
    await appendAiMessage(projectId, 'Just users so far.')
    const conv = await loadConversation(projectId)
    const contents = conv.messages.map(m => m.content)
    expect(contents).toEqual([
      'first user msg',
      'first ai snapshot',
      'what tables exist?',
      'Just users so far.',
    ])
  })
})

describe('Phase 10 — currentBuildState separation', () => {
  test('historical superseded snapshot does not appear in currentBuildState', async () => {
    const projectId = await createProject()
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-S',
      userContent: 'go',
      aiContent: 'Blocked.',
      buildResponse: {
        mode: 'build',
        blocked: [{ id: 'resend', label: 'Resend', reason: 'missing key' }],
        jobStatus: 'blocked',
      },
    })
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-S',
      userContent: '[Resend key]',
      aiContent: 'All connected.',
      buildResponse: { mode: 'build', verified: ['resend'], jobStatus: 'verified' },
    })
    const conv = await loadConversation(projectId)
    // current must NOT include the blocked snapshot
    expect(conv.currentBuildState?.buildResponse.blocked ?? []).toHaveLength(0)
    expect(conv.currentBuildState?.buildResponse.jobStatus).toBe('verified')
  })

  test('clearConversation wipes everything including current build state', async () => {
    const projectId = await createProject()
    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-C',
      userContent: 'go',
      aiContent: 'Built.',
      buildResponse: { mode: 'build', built: [{ id: 't', label: 't' }], jobStatus: 'verified' },
    })
    await clearConversation(projectId)
    const conv = await loadConversation(projectId)
    expect(conv.messages).toHaveLength(0)
    expect(conv.currentBuildState).toBeNull()
  })
})
