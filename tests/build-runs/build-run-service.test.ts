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

/**
 * ORDERING IS THE DATABASE'S JOB
 * ==============================
 * These force the exact ambiguity that made the suite above fail 2 runs in 6,
 * rather than running a flaky test repeatedly and hoping.
 *
 * The old implementation ordered by createdAt and then re-sorted in JavaScript
 * through snapshotSeq. Neither can separate two plain messages written in the
 * same millisecond, and `id` is a random v4 UUID carrying no causality, so the
 * comparator returned 0 and kept whatever order Postgres happened to scan.
 */
describe('Phase 10 — messageSeq is the ordering authority', () => {
  test('orders by insertion when createdAt ties and the UUIDs sort backwards', async () => {
    const projectId = await createProject()

    // Identical to the millisecond, which is the whole point: createdAt cannot
    // separate these.
    const sameInstant = new Date('2026-03-01T12:00:00.000Z')

    // Chosen so a fallback to id ordering produces the WRONG answer: the
    // message written FIRST has the lexically LARGER uuid.
    const firstId = 'ffffffff-0000-4000-8000-000000000001'
    const secondId = '00000000-0000-4000-8000-000000000002'

    await prisma.conversationMessage.create({
      data: { id: firstId, projectId, role: 'user', content: 'asked first', createdAt: sameInstant },
    })
    await prisma.conversationMessage.create({
      data: { id: secondId, projectId, role: 'ai', content: 'answered second', createdAt: sameInstant },
    })

    // The trap is real, not hypothetical: this is what the rows look like to
    // any ordering built from createdAt and id, and it is backwards.
    const byTimestampThenId = await prisma.conversationMessage.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { content: true },
    })
    expect(byTimestampThenId.map(m => m.content)).toEqual(['answered second', 'asked first'])

    // And this is what the sequence says, which is what actually happened.
    const conv = await loadConversation(projectId)
    expect(conv.messages.map(m => m.content)).toEqual(['asked first', 'answered second'])
  })

  test('keeps a snapshot pair ahead of a follow-up written in the same millisecond', async () => {
    const projectId = await createProject()
    const sameInstant = new Date('2026-03-01T12:00:00.000Z')

    await recordBuildSnapshot({
      projectId,
      buildJobId: 'job-tie',
      userContent: 'build me a table',
      aiContent: 'done, users exists',
      buildResponse: { mode: 'build', built: [{ id: 't1', label: 't1' }], jobStatus: 'verified' },
    })
    await appendUserMessage(projectId, 'what tables exist?')
    await appendAiMessage(projectId, 'Just users so far.')

    // Collapse every row onto one instant. The snapshot pair and the follow-up
    // now tie on createdAt, and only the two snapshot rows carry a snapshotSeq,
    // so this is the case the old Infinity default was reaching for.
    await prisma.conversationMessage.updateMany({
      where: { projectId },
      data: { createdAt: sameInstant },
    })

    const conv = await loadConversation(projectId)
    expect(conv.messages.map(m => m.content)).toEqual([
      'build me a table',
      'done, users exists',
      'what tables exist?',
      'Just users so far.',
    ])
  })

  test('gives concurrent inserts distinct sequence values and a stable order', async () => {
    const projectId = await createProject()

    // Genuinely concurrent, so several land in the same millisecond.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => appendUserMessage(projectId, `msg ${i}`)),
    )

    const rows = await prisma.conversationMessage.findMany({
      where: { projectId },
      select: { messageSeq: true },
    })
    expect(rows).toHaveLength(12)
    // A sequence hands out no value twice, so nothing needs a tie-break.
    expect(new Set(rows.map(r => r.messageSeq.toString())).size).toBe(12)

    // No causal order exists BETWEEN truly simultaneous independent writes, and
    // none is claimed. What is required is that the answer never changes.
    const first = (await loadConversation(projectId)).messages.map(m => m.content)
    const second = (await loadConversation(projectId)).messages.map(m => m.content)
    expect(second).toEqual(first)
    expect(first).toHaveLength(12)
  })
})
