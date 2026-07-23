/**
 * POST /api/projects/[id]/assistant — the dashboard Q&A helper.
 *
 * Conversation-only: streams a cheap-model answer grounded in the platform
 * manifest (capabilities.ts) plus this project's connect context. No brain,
 * no tools, no mutations — build/change requests are redirected to the MCP
 * door (Connect) or the Database UI by the system prompt.
 *
 * Free by design: questions never consume assistant credits (the same rule
 * lib/billing enforces everywhere), so the only gate is the per-user rate
 * limit. History is client-held; nothing is persisted here.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { enforceAiChatRateLimit, getRateLimitHeaders } from '@/lib/middleware/rateLimiter'
import { chatCompletionStream, isAIEnabled } from '@/lib/openai/client'
import { assistantPrompt } from '@/lib/ai/brain/prompts'
import { buildConnectManifest } from '@/lib/services/connect-manifest'
import { resolvePublicBaseUrl } from '@/lib/services/public-url'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ASSISTANT_MODEL = process.env.OPENAI_MODEL_FAST || 'gpt-4o-mini'
const MAX_TURNS = 12
const MAX_MESSAGE_CHARS = 4_000

interface ClientMessage {
  role: 'user' | 'assistant'
  content: string
}

function parseMessages(body: unknown): ClientMessage[] | null {
  const raw = (body as { messages?: unknown })?.messages
  if (!Array.isArray(raw) || raw.length === 0) return null
  const messages: ClientMessage[] = []
  for (const m of raw.slice(-MAX_TURNS)) {
    const role = (m as ClientMessage)?.role
    const content = (m as ClientMessage)?.content
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null
    messages.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) })
  }
  if (messages[messages.length - 1].role !== 'user') return null
  return messages
}

/**
 * Compact per-project grounding: names + ready snippets, deliberately NOT the
 * full column/row detail — the assistant guides, it doesn't inspect data.
 */
async function buildProjectContext(projectId: string, projectName: string, origin: string): Promise<string> {
  try {
    const manifest = await buildConnectManifest(projectId, origin)
    const tableNames = manifest.tables.map((t) => t.name)
    const authMethods = manifest.auth.enabled ? manifest.auth.methods.join(', ') : 'not enabled yet'
    return [
      `- Project: "${manifest.project.name}" (id: ${manifest.project.id})`,
      `- Runtime API base: ${manifest.project.apiBaseUrl}`,
      `- Tables (${tableNames.length}): ${tableNames.length ? tableNames.join(', ') : 'none yet'}`,
      `- End-user auth: ${authMethods} · Storage buckets: ${manifest.storage.buckets.length} · Realtime: ${manifest.realtime.enabled ? 'available' : 'available (no subscriptions yet)'}`,
      `- Frontend SDK: \`${manifest.sdk.importLine}\` then \`${manifest.sdk.initLine}\``,
      `- Coding agent (MCP): the Connect section generates the exact per-agent setup (Claude Code, Cursor, any MCP host) with a scoped key.`,
    ].join('\n')
  } catch {
    // Grounding is best-effort — a manifest failure must not take down Q&A.
    return `- Project: "${projectName}" (id: ${projectId})\n- Connect context unavailable right now; answer from the platform manifest and point to the Connect section for exact snippets.`
  }
}

export async function POST(request: NextRequest) {
  return withProjectValidation(request, async ({ projectId, userId, project }) => {
    if (!isAIEnabled()) {
      return NextResponse.json(
        { error: 'The assistant is not available right now.' },
        { status: 503 },
      )
    }

    const rate = await enforceAiChatRateLimit(userId, projectId)
    if (!rate.allowed) {
      return NextResponse.json(
        { error: 'You have hit the rate limit (20 questions per minute). Give it a moment and ask again.' },
        { status: 429, headers: getRateLimitHeaders(rate) },
      )
    }

    const body = await request.json().catch(() => null)
    const messages = parseMessages(body)
    if (!messages) {
      return NextResponse.json(
        { error: 'Send { messages: [{ role, content }] } ending with a user message.' },
        { status: 400 },
      )
    }

    const projectContext = await buildProjectContext(projectId, project.name, resolvePublicBaseUrl(request))

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const tokens = chatCompletionStream(
            [{ role: 'system', content: assistantPrompt(projectContext) }, ...messages],
            { model: ASSISTANT_MODEL, temperature: 0.4, maxTokens: 700 },
          )
          for await (const token of tokens) {
            controller.enqueue(encoder.encode(token))
          }
        } catch (err) {
          console.error('[assistant] stream failed:', err)
          controller.enqueue(encoder.encode('Something went wrong answering that. Try again in a moment.'))
        } finally {
          controller.close()
        }
      },
    })

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        ...getRateLimitHeaders(rate),
      },
    })
  })
}
