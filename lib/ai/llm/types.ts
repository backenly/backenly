/**
 * The AI gateway's vocabulary. Requests and responses use the Anthropic
 * Messages shapes for every provider; the OpenAI adapter translates at its
 * edge, so callers write one shape and never touch a provider SDK.
 */

import type Anthropic from '@anthropic-ai/sdk'

export type ProviderId = 'bedrock' | 'anthropic' | 'openai' | 'scripted'

/**
 * What a call is for. Each purpose has one route (model, thinking, effort,
 * output ceiling, timeout) in lib/ai/llm/config.ts, so a call site states its
 * intent and the deployment decides what serves it.
 */
export type AiPurpose =
  | 'brain.classify'
  | 'brain.summary'
  | 'brain.answer'
  | 'brain.architect'
  | 'brain.agent'
  | 'build.fix_author'
  | 'build.classify'
  | 'build.plan'
  | 'functions.generate'
  | 'insight.explain'
  | 'autonomy.investigate'
  | 'support.answer'
  | 'runtime.generate'
  | 'runtime.fast'

/** The effort levels every routed model accepts. Opus 4.6 has no `xhigh`. */
export type Effort = 'low' | 'medium' | 'high' | 'max'

export interface PurposeRoute {
  model: string
  /** Adaptive thinking. Off means the field is omitted, which on Opus 4.6 runs without thinking. */
  thinking: boolean
  effort: Effort
  /** Hard ceiling on output tokens. Always sent: an unset limit reserves the model maximum against quota. */
  maxTokens: number
  timeoutMs: number
}

export interface GenerateRequest {
  purpose: AiPurpose
  /**
   * Stable instructions. Long enough ones are marked for prompt caching, so
   * keep anything that changes per call (dates, ids, user input) out of here.
   */
  system?: string
  /**
   * Instructions for this call only (the project's current state, a retry
   * note), sent as a second system block after `system`. Keeping them out of
   * `system` is what lets the long stable prompt stay cached across calls.
   */
  context?: string
  messages: Anthropic.MessageParam[]
  /**
   * Also cache the conversation: a breakpoint on the last block of the last
   * message, so the next call of a tool loop reads everything this one sent
   * from the cache instead of paying for the growing transcript again.
   */
  cacheConversation?: boolean
  tools?: Anthropic.Tool[]
  toolChoice?: Anthropic.ToolChoice
  /** Lowers the purpose's output ceiling for this call; never raises it. */
  maxTokens?: number
  /** Ask for JSON that matches this schema (`output_config.format`). */
  jsonSchema?: Record<string, unknown>
  signal?: AbortSignal
  /**
   * Receives the answer's text as it is written, for a reply shown while it
   * streams. Claude providers stream it; the OpenAI adapter delivers the whole
   * text once, at the end. The full result is still returned.
   */
  onText?: (delta: string) => void
  /**
   * Who pays. Defaults by purpose: `autonomy.*` is the deployment's own spend,
   * everything else a customer's (lib/ai/llm/spend.ts).
   */
  payer?: 'customer' | 'platform'
  /**
   * The account a customer-paid call is held against and charged to. With a
   * `projectId`, every call that runs also writes a usage row for the project.
   */
  billing?: { billingAccountId?: string; projectId?: string }
  /** What made the call, recorded as the usage row's endpoint (e.g. 'brain-agent'). Defaults to the purpose. */
  label?: string
}

/** Token counts in one shape for every provider. */
export interface NormalizedUsage {
  /** Every prompt token: uncached input, cache writes and cache reads. */
  promptTokens: number
  /** Prompt tokens neither read from nor written to the cache. */
  inputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  outputTokens: number
}

export interface GenerateResult {
  provider: ProviderId
  model: string
  message: Anthropic.Message
  /** Every text block, joined. */
  text: string
  /** Present when `jsonSchema` was requested. */
  json?: unknown
  usage: NormalizedUsage
  costUsd: number
  /** Requests sent, including retries of ones rejected before inference. */
  attempts: number
}

export interface SendOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** Stream and collect the final message. Used for long outputs and thinking, where a single response risks an HTTP timeout. */
  stream: boolean
  /** Receives the answer's text as it is written, where the provider streams it. */
  onText?: (delta: string) => void
}

/** One provider. Throws its own errors; the gateway classifies them. */
export interface LlmProvider {
  id: ProviderId
  send(params: Anthropic.MessageCreateParamsNonStreaming, opts: SendOptions): Promise<Anthropic.Message>
}
