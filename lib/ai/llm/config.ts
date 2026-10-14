/**
 * Which provider serves AI on this deployment, and how each purpose is routed.
 *
 * Provider, from the environment:
 *   AI_PROVIDER=bedrock    Claude on Amazon Bedrock. Credentials come from the
 *                          AWS provider chain (on ECS, the task role); no key is
 *                          stored. Needs BEDROCK_REGION or AWS_REGION.
 *   AI_PROVIDER=anthropic  The Claude API. Needs ANTHROPIC_API_KEY.
 *   AI_PROVIDER=openai     OpenAI. Needs OPENAI_API_KEY.
 *   unset                  ANTHROPIC_API_KEY, then OPENAI_API_KEY, if present.
 *                          Bedrock is never inferred: an AWS credential chain
 *                          exists on any AWS host, so choosing it is explicit.
 *
 * Model, per purpose: AI_MODEL_<PURPOSE> (e.g. AI_MODEL_BRAIN_AGENT), then
 * AI_MODEL, then the provider's default. On OpenAI the older variables still
 * apply: OPENAI_MODEL_FAST, OPENAI_MODEL, AUTONOMY_FIX_MODEL,
 * AUTONOMY_DIAGNOSIS_MODEL.
 */

import type { AiPurpose, ProviderId, PurposeRoute } from './types'

/** The only model the Cloud account has enabled. Global profile: ap-south-1 reaches it only this way. */
export const BEDROCK_DEFAULT_MODEL = 'global.anthropic.claude-opus-4-6-v1'
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-6'

const ROUTES: Record<AiPurpose, Omit<PurposeRoute, 'model'>> = {
  'brain.classify':       { thinking: false, effort: 'low',    maxTokens: 1024,  timeoutMs: 30_000 },
  'brain.summary':        { thinking: false, effort: 'low',    maxTokens: 2048,  timeoutMs: 60_000 },
  'brain.answer':         { thinking: false, effort: 'medium', maxTokens: 2048,  timeoutMs: 60_000 },
  // One long JSON design. No thinking: the spec is the plan, and a slow design
  // call is what a chat turn's wall clock cuts.
  'brain.architect':      { thinking: false, effort: 'high',   maxTokens: 16000, timeoutMs: 180_000 },
  'brain.agent':          { thinking: true,  effort: 'high',   maxTokens: 16000, timeoutMs: 180_000 },
  'build.fix_author':     { thinking: true,  effort: 'high',   maxTokens: 16000, timeoutMs: 180_000 },
  // The older build and orchestration pipelines: short structured judgements,
  // and longer JSON plans. Their prompts ask for JSON and are parsed as such.
  'build.classify':       { thinking: false, effort: 'low',    maxTokens: 4096,  timeoutMs: 60_000 },
  'build.plan':           { thinking: false, effort: 'medium', maxTokens: 16000, timeoutMs: 180_000 },
  'functions.generate':   { thinking: true,  effort: 'high',   maxTokens: 16000, timeoutMs: 180_000 },
  // Explanations a person reads: impact, guidance, simulations, the assistant.
  'insight.explain':      { thinking: false, effort: 'medium', maxTokens: 4096,  timeoutMs: 90_000 },
  'autonomy.investigate': { thinking: true,  effort: 'max',    maxTokens: 32000, timeoutMs: 300_000 },
  // The support case first responder: one grounded answer a person reads while
  // the ticket is already filed. Platform-paid (lib/ai/llm/spend.ts).
  'support.answer':       { thinking: false, effort: 'medium', maxTokens: 2048,  timeoutMs: 60_000 },
  // The public /v1/{projectId}/ai/generate endpoint: `default` and `fast`.
  'runtime.generate':     { thinking: false, effort: 'medium', maxTokens: 4096,  timeoutMs: 60_000 },
  'runtime.fast':         { thinking: false, effort: 'low',    maxTokens: 4096,  timeoutMs: 30_000 },
}

export const ALL_PURPOSES = Object.keys(ROUTES) as AiPurpose[]

export type ProviderConfig =
  | { id: 'bedrock'; region: string }
  | { id: 'anthropic'; apiKey: string }
  | { id: 'openai'; apiKey: string }

export type ProviderResolution =
  | { ok: true; config: ProviderConfig }
  | { ok: false; reason: string }

type Env = Record<string, string | undefined>

const set = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined)

export function resolveProvider(env: Env = process.env): ProviderResolution {
  const chosen = set(env.AI_PROVIDER)?.toLowerCase()
  const anthropicKey = set(env.ANTHROPIC_API_KEY)
  const openaiKey = set(env.OPENAI_API_KEY)

  if (chosen === 'bedrock') {
    const region = set(env.BEDROCK_REGION) ?? set(env.AWS_REGION)
    return region
      ? { ok: true, config: { id: 'bedrock', region } }
      : { ok: false, reason: 'AI_PROVIDER is bedrock, but neither BEDROCK_REGION nor AWS_REGION is set.' }
  }
  if (chosen === 'anthropic') {
    return anthropicKey
      ? { ok: true, config: { id: 'anthropic', apiKey: anthropicKey } }
      : { ok: false, reason: 'AI_PROVIDER is anthropic, but ANTHROPIC_API_KEY is not set.' }
  }
  if (chosen === 'openai') {
    return openaiKey
      ? { ok: true, config: { id: 'openai', apiKey: openaiKey } }
      : { ok: false, reason: 'AI_PROVIDER is openai, but OPENAI_API_KEY is not set.' }
  }
  if (chosen) {
    return { ok: false, reason: `AI_PROVIDER "${chosen}" is not one of bedrock, anthropic or openai.` }
  }
  if (anthropicKey) return { ok: true, config: { id: 'anthropic', apiKey: anthropicKey } }
  if (openaiKey) return { ok: true, config: { id: 'openai', apiKey: openaiKey } }
  return {
    ok: false,
    reason: 'No AI provider is configured. Set AI_PROVIDER=bedrock with BEDROCK_REGION, or ANTHROPIC_API_KEY, or OPENAI_API_KEY.',
  }
}

/** Whether AI can be called here, and if not, a sentence saying why. Configuration only: a configured provider can still fail. */
export function aiAvailability(env: Env = process.env): { available: true; provider: ProviderId } | { available: false; reason: string } {
  const r = resolveProvider(env)
  return 'reason' in r ? { available: false, reason: r.reason } : { available: true, provider: r.config.id }
}

function openaiDefault(purpose: AiPurpose, env: Env): string {
  switch (purpose) {
    case 'brain.classify':
    case 'brain.summary':
    case 'build.classify':
    case 'runtime.fast':
      return set(env.OPENAI_MODEL_FAST) ?? 'gpt-4o-mini'
    case 'build.fix_author':
      return set(env.AUTONOMY_FIX_MODEL) ?? 'gpt-4o'
    case 'autonomy.investigate':
      return set(env.AUTONOMY_DIAGNOSIS_MODEL) ?? 'gpt-4o'
    default:
      return set(env.OPENAI_MODEL) ?? 'gpt-4.1'
  }
}

export function routeFor(purpose: AiPurpose, provider: ProviderId, env: Env = process.env): PurposeRoute {
  const base = ROUTES[purpose]
  const perPurpose = set(env[`AI_MODEL_${purpose.replace(/\./g, '_').toUpperCase()}`])
  const model =
    perPurpose ??
    set(env.AI_MODEL) ??
    (provider === 'bedrock'
      ? BEDROCK_DEFAULT_MODEL
      : provider === 'openai'
        ? openaiDefault(purpose, env)
        : ANTHROPIC_DEFAULT_MODEL)
  return { ...base, model }
}
