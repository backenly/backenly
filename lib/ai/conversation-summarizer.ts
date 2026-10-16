/**
 * CONVERSATION SUMMARIZER (#7)
 * ==============================
 * Compresses long conversation histories into a rolling structured summary
 * so the AI always has relevant context without hitting token limits.
 *
 * Strategy:
 *  - When total messages > SUMMARY_THRESHOLD, generate a structured summary
 *  - Store summary as a ConversationMessage with role='summary'
 *  - On history load: return summary + last RECENT_TURNS raw turns
 *  - Next session picks up exactly where it left off, no "I forgot" problem
 *
 * Storage: reuses ConversationMessage table (role='summary' is a valid String)
 * Cost: the gateway's brain.summary route (low effort, no thinking) — summarization is cheap
 */

/** Trigger summarization when total raw messages exceed this count */
const SUMMARY_THRESHOLD = 20

/** How many raw turns to keep after a summary exists */
const RECENT_TURNS_AFTER_SUMMARY = 6

export interface ConversationSummary {
  builtSoFar: string[]      // tables/features built
  decisions: string[]        // key decisions made
  userPreferences: string[]  // things the user likes/dislikes
  currentFocus: string       // what the user is working on right now
  rawTurnCount: number       // how many raw turns were summarized
  summarizedAt: string       // ISO timestamp
}

/**
 * Load conversation history with summarization awareness.
 * Returns summary context + recent turns (or just recent turns if no summary yet).
 */
export async function loadHistoryWithSummary(
  projectId: string,
): Promise<{ history: Array<{ role: 'user' | 'assistant'; content: string }>; summaryContext: string }> {
  const { prisma } = await import('@/lib/db/prisma')
  // A regional project's words are in its region (lib/ai/conversation-content.ts).
  const { withMessageContents } = await import('@/lib/ai/conversation-content')

  try {
    // Check for an existing summary
    const [summaryRow] = await withMessageContents(
      projectId,
      await prisma.conversationMessage.findMany({
        where: { projectId, role: 'summary' },
        orderBy: { messageSeq: 'desc' },
        take: 1,
        select: { id: true, content: true, createdAt: true },
      }),
    )

    // How many raw messages to load
    const rawLimit = summaryRow ? RECENT_TURNS_AFTER_SUMMARY : SUMMARY_THRESHOLD

    // Load most-recent raw messages (desc then reverse for chronological order).
    // Include ALL messages (including build-state ones with noSummarize) so the
    // chat panel shows the full step-by-step credential flow on refresh.
    const rawRows = await withMessageContents(
      projectId,
      await prisma.conversationMessage.findMany({
        where: { projectId, role: { in: ['user', 'ai'] } },
        // messageSeq, not createdAt: this picks WHICH messages are the most
        // recent and then reverses them into the history the model reads, so a
        // millisecond tie here reorders the conversation it is shown.
        orderBy: { messageSeq: 'desc' },
        take: rawLimit,
        select: { id: true, role: true, content: true, metadata: true },
      }),
    )
    rawRows.reverse()

    const history = rawRows.map((r: { role: string; content: string; metadata?: unknown }) => ({
      role: (r.role === 'ai' ? 'assistant' : r.role) as 'user' | 'assistant',
      content: r.content,
    }))

    // Build summary context block for the system prompt
    let summaryContext = ''
    if (summaryRow) {
      try {
        const summary = JSON.parse(summaryRow.content) as ConversationSummary
        summaryContext = buildSummaryContext(summary)
      } catch {
        // Summary is plain text — use as-is
        summaryContext = `\n## CONVERSATION HISTORY SUMMARY\n${summaryRow.content}`
      }
    }

    return { history, summaryContext }
  } catch {
    return { history: [], summaryContext: '' }
  }
}

/**
 * Called after a response is saved.
 * If total raw message count > threshold, generates and saves a new summary.
 * Non-blocking — called with .catch(() => {}) so it never delays the response.
 */
export async function maybeSummarizeConversation(projectId: string): Promise<void> {
  const { prisma } = await import('@/lib/db/prisma')
  const { createConversationMessage, deleteConversationMessages, withMessageContents } = await import(
    '@/lib/ai/conversation-content'
  )

  // Count raw messages
  const rawCount = await prisma.conversationMessage.count({
    where: { projectId, role: { in: ['user', 'ai'] } },
  })

  if (rawCount < SUMMARY_THRESHOLD) return

  // Check when the last summary was made
  const lastSummary = await prisma.conversationMessage.findFirst({
    where: { projectId, role: 'summary' },
    orderBy: { messageSeq: 'desc' },
    select: { createdAt: true, content: true },
  })

  // Only re-summarize if 10+ new messages since last summary
  if (lastSummary) {
    const messagesSinceSummary = await prisma.conversationMessage.count({
      where: {
        projectId,
        role: { in: ['user', 'ai'] },
        createdAt: { gt: lastSummary.createdAt },
      },
    })
    if (messagesSinceSummary < 10) return
  }

  // Load all raw messages for summarization, excluding build-state snapshots.
  // Messages with metadata.noSummarize = true are structured build state (e.g.
  // "✓ Stripe connected — now I need Resend") that must not be compressed into
  // a generic summary — doing so is what caused chat text to look different on refresh.
  // A region that cannot be read throws here, so no summary is made from blanks.
  const allMessages = await withMessageContents(
    projectId,
    await prisma.conversationMessage.findMany({
      where: { projectId, role: { in: ['user', 'ai'] } },
      orderBy: { messageSeq: 'asc' },
      select: { id: true, role: true, content: true, metadata: true },
    }),
  )

  const summarizableMessages = allMessages.filter((m: { metadata: unknown }) => {
    const meta = m.metadata as Record<string, unknown> | null
    return !meta || meta.noSummarize !== true
  })

  const summary = await generateSummary(summarizableMessages, rawCount, projectId)
  if (!summary) return

  // Save as a summary ConversationMessage (replaces previous if exists).
  // First delete old summary. It is made from the conversation, so it is kept
  // where the conversation's words are.
  await deleteConversationMessages(projectId, { role: 'summary' })

  await createConversationMessage({ projectId, role: 'summary', content: JSON.stringify(summary) })

  console.log(`[Summarizer] Summarized ${rawCount} messages for project ${projectId}`)
}

/** The summary's shape, as structured output: every object closed, every field required. */
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['builtSoFar', 'decisions', 'userPreferences', 'currentFocus'],
  properties: {
    builtSoFar: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    userPreferences: { type: 'array', items: { type: 'string' } },
    currentFocus: { type: 'string' },
  },
}

async function generateSummary(
  messages: Array<{ role: string; content: string }>,
  rawCount: number,
  projectId: string,
): Promise<ConversationSummary | null> {
  try {
    const { generate } = await import('./llm')

    const transcript = messages
      .slice(-40) // Use last 40 messages max for summarization
      .map(m => `${m.role === 'ai' ? 'AI' : 'User'}: ${m.content.slice(0, 500)}`)
      .join('\n')

    const reply = await generate({
      purpose: 'brain.summary',
      system: `You are a conversation summarizer for an autonomous backend platform (Backenly).
Extract the key facts from this conversation.

Focus on:
- What backend resources were built (table names, features)
- Key architectural decisions made
- User preferences and style (verbose/terse, what they liked/disliked)
- What the user is currently working on

Fields:
- builtSoFar: e.g. ["users table", "products table", "auth"]
- decisions: e.g. ["chose JWT over session auth", "decided to add RLS for orders"]
- userPreferences: e.g. ["prefers terse responses", "wants FKs enforced"]
- currentFocus: one sentence describing what they're building right now`,
      messages: [{ role: 'user', content: `Summarize this conversation:\n\n${transcript}` }],
      jsonSchema: SUMMARY_SCHEMA,
      maxTokens: 1024,
      billing: { projectId },
      label: 'summarizer',
    })

    const parsed = (reply.json ?? {}) as {
      builtSoFar?: string[]
      decisions?: string[]
      userPreferences?: string[]
      currentFocus?: string
    }

    return {
      builtSoFar: parsed.builtSoFar || [],
      decisions: parsed.decisions || [],
      userPreferences: parsed.userPreferences || [],
      currentFocus: parsed.currentFocus || '',
      rawTurnCount: rawCount,
      summarizedAt: new Date().toISOString(),
    }
  } catch (err: any) {
    console.warn('[Summarizer] Failed to generate summary:', err?.message)
    return null
  }
}

function buildSummaryContext(summary: ConversationSummary): string {
  const lines: string[] = ['\n## CONVERSATION SUMMARY (from prior session turns)']

  if (summary.currentFocus) {
    lines.push(`Current focus: ${summary.currentFocus}`)
  }

  if (summary.builtSoFar.length > 0) {
    lines.push(`Already built: ${summary.builtSoFar.join(', ')}`)
  }

  if (summary.decisions.length > 0) {
    lines.push('Key decisions:')
    summary.decisions.slice(-5).forEach(d => lines.push(`  • ${d}`))
  }

  if (summary.userPreferences.length > 0) {
    lines.push('User preferences:')
    summary.userPreferences.slice(-3).forEach(p => lines.push(`  • ${p}`))
  }

  lines.push(`(Summary covers ${summary.rawTurnCount} prior messages as of ${summary.summarizedAt.slice(0, 10)})`)

  return lines.join('\n')
}
