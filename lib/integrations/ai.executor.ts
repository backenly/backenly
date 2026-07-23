/**
 * AI PROVIDER INTEGRATION EXECUTOR — BEHAVIORAL CHAIN
 * =====================================================
 * Phase 2: Moves beyond table creation to generating protected, rate-limited
 * AI endpoints that use the stored key via ctx.integrations.
 *
 * States produced:
 *   key_stored          → Key stored (no mock mode — AI requires a real key).
 *   partially_configured → Key + table exist, route generation failed.
 *   behaviorally_ready   → Key + table + /ai/chat endpoint generated.
 *                          Optional /ai/embed added when relevant tables exist.
 *
 * Behavioral chain:
 *   1. Require API key (no mock mode)
 *   2. Create `ai_responses` table (caching + usage tracking)
 *   3. Generate POST /ai/chat endpoint (auth-protected, rate-limited)
 *   4. Detect content/text tables → generate POST /ai/embed (optional)
 *   5. Compute readiness and persist it
 */

import { prisma } from '@/lib/db/prisma'
import { storeIntegrationKey, hasIntegrationKey } from '@/lib/services/integrationKeyStore'
import { executeAction } from '@/lib/ai/minimal-executor'
import { executeGenerateFunction } from '@/lib/ai/function-generator'
import { withAgentTransaction } from '@/lib/ai/transaction-manager'
import { emit } from '@/lib/events/bus'
import {
  checkIntegrationReadiness,
  toIntegrationRecord,
  formatReadinessReport,
} from './readiness'

// PostHog is NOT an LLM — it is handled by lib/integrations/posthog.executor.ts.
export type AiProvider = 'openai' | 'anthropic'

export interface AiIntegrationResult {
  success: boolean
  message: string
  needsApiKey?: boolean
  keyHint?: string
  readiness?: string
}

// Table names that suggest vector/embedding use cases
const EMBEDDING_RELEVANT_TABLES = [
  'posts', 'articles', 'documents', 'content', 'messages',
  'products', 'listings', 'entries', 'notes', 'items',
]

export async function executeAiIntegration(
  projectId: string,
  provider: AiProvider,
  apiKey?: string,
): Promise<AiIntegrationResult> {
  const keyExists = await hasIntegrationKey(projectId, provider)
  const PROVIDER_META: Record<string, { name: string; keyExample: string; keyDocsUrl: string }> = {
    openai:    { name: 'OpenAI',    keyExample: 'sk-...',        keyDocsUrl: 'platform.openai.com → API Keys' },
    anthropic: { name: 'Anthropic', keyExample: 'sk-ant-...',    keyDocsUrl: 'console.anthropic.com → API Keys' },
  }
  const { name: providerName, keyExample, keyDocsUrl } = PROVIDER_META[provider] ?? PROVIDER_META.openai

  // AI integration requires a real key — no mock mode.
  // Short one-liner — the new ChoiceView credential card delivers the full
  // "Do you have the key? / Use placeholder / Show me how to get one" UX.
  if (!keyExists && !apiKey) {
    return {
      success: false,
      needsApiKey: true,
      message: `${providerName} needs an API key — pick how you want to proceed in the card below.`,
      keyHint: `Paste your ${providerName} API key (${keyExample})`,
    }
  }

  // ── Live key validation — verify the key against OpenAI before storing ────
  // Uses the lightweight /v1/models list endpoint (no tokens consumed).
  if (apiKey && provider === 'openai') {
    try {
      const checkRes = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(6000),
      })
      if (checkRes.status === 401) {
        return {
          success: false,
          message: [
            '**Invalid OpenAI API key.** The key was rejected by OpenAI.',
            '',
            'Make sure you copied the full key (starts with `sk-` or `sk-proj-`) and try again.',
            'Find your keys at platform.openai.com → API Keys.',
          ].join('\n'),
        }
      }
      if (checkRes.status === 429) {
        // Rate-limited but key is valid — proceed
        console.log('[AI Executor] OpenAI returned 429 (rate-limited) — key accepted as valid')
      }
    } catch {
      // Network timeout — proceed optimistically
    }
  }

  const autoWiredSteps: string[] = []

  // ── Transaction: store key + create table ─────────────────────────────────
  const txResult = await withAgentTransaction(projectId, async (ctx) => {
    if (apiKey) {
      await storeIntegrationKey(projectId, provider, apiKey)
      ctx.record({ type: 'key_stored', payload: { integrationId: provider } })
    }

    // ai_responses — caching and usage tracking for all AI calls
    const tblResult = await executeAction({
      action: 'CREATE_TABLE',
      params: {
        tableName: 'ai_responses',
        columns: [
          { name: 'prompt_hash',      type: 'TEXT' },         // SHA-256 of normalized prompt
          { name: 'model',            type: 'TEXT', notNull: true },
          { name: 'provider',         type: 'TEXT', notNull: true, default: provider },
          { name: 'response',         type: 'TEXT' },
          { name: 'tokens_used',      type: 'INTEGER' },
          { name: 'prompt_tokens',    type: 'INTEGER' },
          { name: 'completion_tokens',type: 'INTEGER' },
          { name: 'latency_ms',       type: 'INTEGER' },
          { name: 'cached',           type: 'BOOLEAN', default: 'false' },
          { name: 'user_id',          type: 'TEXT' },         // which end-user triggered this
          { name: 'error',            type: 'TEXT' },
        ],
      },
    }, projectId)
    if (tblResult.success) {
      autoWiredSteps.push('✅ `ai_responses` table created (caching + usage tracking)')
      ctx.record({ type: 'table_created', payload: { tableName: 'ai_responses' } })
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeIntegrations: true },
    })
    const existing = (project?.activeIntegrations as Record<string, any>) ?? {}
    await prisma.project.update({
      where: { id: projectId },
      data: {
        activeIntegrations: {
          ...existing,
          [provider]: {
            enabled: true,
            readiness: 'partially_configured',
            activatedAt: existing[provider]?.activatedAt ?? new Date().toISOString(),
            activatedBy: 'integration_executor',
            tables: ['ai_responses'],
          },
        },
      },
    })
    ctx.record({ type: 'integration_activated', payload: { integrationId: provider } })
  })

  if (!txResult.success) {
    return {
      success: false,
      message: txResult.rolledBack
        ? `AI integration setup failed and was rolled back: ${txResult.message}`
        : `AI integration setup failed: ${txResult.message}`,
    }
  }

  // ── Generate behavioral endpoints ──────────────────────────────────────────

  // 3. POST /ai/chat — auth-protected, rate-limited chat completion endpoint
  const chatResult = await executeGenerateFunction(
    {
      functionName: `${provider}-chat`,
      description: [
        `AI chat completion endpoint using ${providerName}.`,
        `Accept { prompt: string, systemPrompt?: string, maxTokens?: number } in the request body.`,
        `Require authentication — return 401 for unauthenticated requests.`,
        `Apply rate limiting: reject with 429 if the authenticated user has made more than 10 requests in the last 60 seconds.`,
        `Track rate limiting by user_id using a sliding-window count in ai_responses.`,
        `Call ctx.integrations.${provider}.complete(prompt, maxTokens, systemPrompt) — it returns the assistant reply as a string.`,
        `On success: insert a row into ai_responses with provider="${provider}", latency_ms, user_id, and cached=false.`,
        `Return { reply: assistantReply }.`,
        `On error: return 500 with { error: message }.`,
      ].join(' '),
      method: 'POST',
    },
    projectId,
  ).catch(() => ({ success: false }))
  if (chatResult.success) {
    autoWiredSteps.push(`✅ Generated \`POST /fn/${provider}-chat\` (auth-protected, rate-limited)`)
  }

  // 4. POST /ai/embed — OpenAI only. Anthropic has no embeddings API, so an
  //    anthropic-embed function would be unrunnable — never generate it.
  //    Only generate when an embedding-relevant table exists.
  if (provider === 'openai') {
    const embeddingTable = await prisma.table.findFirst({
      where: { projectId, name: { in: EMBEDDING_RELEVANT_TABLES } },
      select: { id: true, name: true },
    })
    if (embeddingTable) {
      const embedResult = await executeGenerateFunction(
        {
          functionName: 'openai-embed',
          description: [
            `Text embedding endpoint using OpenAI.`,
            `Accept { text: string } in the request body.`,
            `Require authentication — return 401 for unauthenticated requests.`,
            `Apply rate limiting: reject with 429 if the user has made more than 20 embedding requests in the last 60 seconds.`,
            `Call ctx.integrations.openai.embed(text) — it returns a number[] embedding vector.`,
            `On success: insert a row into ai_responses with provider="openai", latency_ms, and cached=false.`,
            `Return { embedding: number[] }.`,
            `On error: return 500 with { error: message }.`,
          ].join(' '),
          method: 'POST',
        },
        projectId,
      ).catch(() => ({ success: false }))
      if (embedResult.success) {
        autoWiredSteps.push(`✅ Generated \`POST /fn/openai-embed\` (detected \`${embeddingTable.name}\` table)`)
      }
    }
  }

  // ── Emit events ────────────────────────────────────────────────────────────
  emit('integration.activated', projectId, { integrationId: provider, tables: ['ai_responses'] })

  import('@/lib/versioning/schema-versions').then(({ snapshotSchema }) =>
    snapshotSchema(
      projectId,
      `${providerName} integration: ai_responses + chat endpoint`,
      'ai_executor',
    ).catch(() => {})
  )

  // ── Compute final readiness ────────────────────────────────────────────────
  const readinessReport = await checkIntegrationReadiness(projectId, provider)

  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: { activeIntegrations: true },
  })
  const existingIntegrations = (proj?.activeIntegrations as Record<string, any>) ?? {}
  await prisma.project.update({
    where: { id: projectId },
    data: {
      activeIntegrations: {
        ...existingIntegrations,
        [provider]: toIntegrationRecord(readinessReport, {
          activatedAt: existingIntegrations[provider]?.activatedAt ?? new Date().toISOString(),
          activatedBy: 'integration_executor',
          tables: ['ai_responses'],
        }),
      },
    },
  })

  const stepsMsg = `\n\n**Auto-wired:**\n${autoWiredSteps.join('\n')}`
  const readinessMsg = `\n\n${formatReadinessReport(readinessReport)}`

  return {
    success: true,
    message: `${providerName} connected.${stepsMsg}${readinessMsg}`,
    readiness: readinessReport.status,
  }
}
