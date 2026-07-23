/**
 * Shared conversation persistence utilities used by multiple pipeline stages.
 * Extracted from route.ts so each stage can import without circular deps.
 */

import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'

export async function loadHistory(projectId: string): Promise<{
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  summaryContext: string
}> {
  try {
    const { loadHistoryWithSummary } = await import('@/lib/ai/conversation-summarizer')
    return await loadHistoryWithSummary(projectId)
  } catch {
    return { history: [], summaryContext: '' }
  }
}

/**
 * Persist a user/assistant exchange.
 *
 * Idempotency contract (requestId):
 *   When `requestId` is provided, the row is keyed on it. If another writer
 *   (route handler, brain saveTurn, retried client request) already persisted
 *   a row with the same `(projectId, role, requestId)` tuple, this is a no-op.
 *   That kills the dual-writer duplicate problem at the source — the only
 *   correct way to handle it. No content-based heuristics, no time windows.
 *
 *   Pass null/empty for either side to skip that insert (used when the route
 *   handler has already persisted the user message at request start).
 */
export async function saveMessages(
  projectId: string,
  userContent: string,
  aiContent: string,
  requestId?: string | null,
): Promise<void> {
  try {
    const metaUser: Record<string, unknown> | undefined = requestId
      ? { requestId, side: 'user' }
      : undefined
    const metaAi: Record<string, unknown> | undefined = requestId
      ? { requestId, side: 'ai' }
      : undefined

    const writes: Array<Promise<unknown>> = []
    if (userContent) {
      writes.push(insertIfNotExists(projectId, 'user', userContent, metaUser, requestId))
    }
    if (aiContent) {
      writes.push(insertIfNotExists(projectId, 'ai', aiContent, metaAi, requestId))
    }
    await Promise.all(writes)

    import('@/lib/ai/conversation-summarizer')
      .then(({ maybeSummarizeConversation }) => maybeSummarizeConversation(projectId))
      .catch(() => {})
  } catch (err) {
    console.error('[ConvStore] Failed to save messages:', err)
  }
}

/**
 * Insert a single message, idempotent on (projectId, role, requestId).
 * Exported for the route handler and the messages POST endpoint so every
 * writer dedups against the same key.
 */
export async function insertIfNotExists(
  projectId: string,
  role: 'user' | 'ai',
  content: string,
  metadata?: Record<string, unknown>,
  requestId?: string | null,
): Promise<void> {
  if (!content) return
  if (requestId) {
    const existing = await prisma.conversationMessage.findFirst({
      where: {
        projectId,
        role,
        metadata: { path: ['requestId'], equals: requestId },
      },
      select: { id: true },
    })
    if (existing) {
      console.log(`[ConvStore] Skip duplicate ${role} (requestId=${requestId})`)
      return
    }
  }
  await prisma.conversationMessage.create({
    data: {
      projectId,
      role,
      content,
      metadata: (metadata ?? {}) as Prisma.InputJsonValue,
    },
  })
}

/**
 * Save build-runtime messages with 3-pass deduplication so that a resumed
 * build never creates a duplicate "Blocked — credentials needed" entry.
 */
export async function saveBuildMessages(
  projectId: string,
  userContent: string,
  aiContent: string,
  buildJobId: string,
  buildResponseData?: any,
): Promise<void> {
  try {
    const { FLAGS } = await import('@/lib/config/flags')
    if (FLAGS.ENABLE_PHASE_10_BUILD_HISTORY) {
      const { recordBuildSnapshot } = await import('@/lib/build-runs/build-run-service')
      await recordBuildSnapshot({ projectId, buildJobId, userContent, aiContent, buildResponse: buildResponseData })
      return
    }
  } catch (err) {
    console.error('[ConvStore] Phase 10 service path failed, falling back:', err)
  }

  try {
    const escapeForLike = (s: string) => s.replace(/%/g, '\\%').replace(/_/g, '\\_')
    const jobIdLikePattern = `%"buildJobId":"${escapeForLike(buildJobId)}"%`

    // Pass 1: JSONB operator
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ConversationMessage"
       WHERE "projectId" = $1 AND role = 'ai'
         AND metadata IS NOT NULL
         AND (metadata->>'buildJobId') = $2`,
      projectId,
      buildJobId,
    ).catch((err: any) => console.warn('[ConvStore] dedup Pass 1 (non-fatal):', err?.message))

    // Pass 2: text LIKE on cast
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ConversationMessage"
       WHERE "projectId" = $1 AND role = 'ai'
         AND metadata IS NOT NULL
         AND metadata::text LIKE $2`,
      projectId,
      jobIdLikePattern,
    ).catch((err: any) => console.warn('[ConvStore] dedup Pass 2 (non-fatal):', err?.message))

    // Pass 3: content-based tombstone
    try {
      const candidates = await prisma.conversationMessage.findMany({
        where: { projectId, role: 'ai' },
        select: { id: true, metadata: true, content: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
      const toDelete = candidates
        .filter((m) => {
          const meta = m.metadata as any
          if (meta && typeof meta === 'object' && meta.buildJobId === buildJobId) return true
          if (
            typeof m.content === 'string' &&
            m.content.includes('**Blocked — credentials needed:**') &&
            !m.content.includes('All integrations')
          )
            return true
          return false
        })
        .map((m) => m.id)
      if (toDelete.length > 0) {
        await prisma.conversationMessage.deleteMany({ where: { id: { in: toDelete } } })
        console.log(`[ConvStore] dedup Pass 3 tombstoned ${toDelete.length} stale message(s)`)
      }
    } catch (err: any) {
      console.warn('[ConvStore] dedup Pass 3 (non-fatal):', err?.message)
    }

    await prisma.conversationMessage.createMany({
      data: [
        { projectId, role: 'user', content: userContent },
        {
          projectId,
          role: 'ai',
          content: aiContent,
          metadata: {
            buildJobId,
            savedAt: new Date().toISOString(),
            noSummarize: true,
            ...(buildResponseData ? { buildResponse: buildResponseData } : {}),
          },
        },
      ],
    })
  } catch (err) {
    console.error('[ConvStore] Failed to save build messages:', err)
    await saveMessages(projectId, userContent, aiContent).catch(() => {})
  }
}

export function buildIntegrationSetupSession(integrationId: string, keyValid: boolean): string {
  const SESSIONS: Record<string, { steps: string[]; nextAction: string }> = {
    resend: {
      steps: [
        '✓ Step 1: Detect intent',
        '✓ Step 2: Key received and stored',
        keyValid
          ? '✓ Step 3: Key verified against Resend API'
          : '✗ Step 3: Key invalid — check and re-paste',
        keyValid ? '○ Step 4: Say "add welcome email" or "add order notification" to activate' : '',
      ],
      nextAction: 'Say "add welcome email" to create an email trigger template.',
    },
    sendgrid: {
      steps: [
        '✓ Step 1: Detect intent',
        '✓ Step 2: Key received and stored',
        keyValid
          ? '✓ Step 3: Key verified against SendGrid API'
          : '✗ Step 3: Key invalid — check and re-paste',
        keyValid ? '○ Step 4: Say "add email notification" to activate templates' : '',
      ],
      nextAction: 'Say "add email notification" to create an email trigger.',
    },
    stripe: {
      steps: [
        '✓ Step 1: Detect intent',
        '✓ Step 2: Key received and stored',
        keyValid
          ? '✓ Step 3: Key verified against Stripe API'
          : '✗ Step 3: Key invalid — check and re-paste',
        keyValid
          ? '○ Step 4: Say "add stripe payment feature" to build the full payment flow'
          : '',
      ],
      nextAction:
        'Say "add stripe payment feature" to create the orders table + webhook handler.',
    },
    openai: {
      steps: [
        '✓ Step 1: Key received and stored',
        keyValid
          ? '✓ Step 2: Key format valid (test via Functions tab)'
          : '✗ Step 2: Key invalid — check and re-paste',
        keyValid ? '○ Step 3: Say "add AI function" to create a serverless AI function' : '',
      ],
      nextAction: 'Say "add AI function" to create a serverless AI function.',
    },
    anthropic: {
      steps: [
        '✓ Step 1: Key received and stored',
        keyValid
          ? '✓ Step 2: Key format valid (test via Functions tab)'
          : '✗ Step 2: Key invalid — check and re-paste',
        keyValid ? '○ Step 3: Say "add AI function" to create a serverless AI function' : '',
      ],
      nextAction: 'Say "add AI function" to create a serverless AI function.',
    },
  }

  const session = SESSIONS[integrationId]
  if (!session) return ''
  const stepLines = session.steps.filter(Boolean).join('\n')
  return `\n\n**Integration Setup Session — ${integrationId.charAt(0).toUpperCase() + integrationId.slice(1)}**\n${stepLines}`
}
