/**
 * INTEGRATION FAILOVER SERVICE — Issue #91
 * ==========================================
 * Provides automatic failover/fallback when a primary integration provider
 * is down or returns errors. Prevents the backend from stopping when one
 * provider goes down.
 *
 * Usage patterns:
 *  - Video generation: Runway ML → Replicate → Stability AI
 *  - Email: Resend → SendGrid → log-only fallback
 *  - AI: OpenAI → Anthropic → static fallback
 *
 * Callers:
 *  - Job processors use withVideoFailover() to pick the available provider
 *  - Email senders use withEmailFailover() to try providers in order
 */

import { getIntegrationKey } from '@/lib/services/integrationKeyStore'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FailoverResult<T> {
  success: boolean
  result?: T
  providerId: string
  providerName: string
  attemptCount: number
  lastError?: string
}

export interface ProviderAttempt {
  integrationId: string
  name: string
}

// ── Failover chains ───────────────────────────────────────────────────────────

/** Video generation: Runway ML → Replicate → Stability AI */
export const VIDEO_PROVIDER_CHAIN: ProviderAttempt[] = [
  { integrationId: 'runway',     name: 'Runway ML' },
  { integrationId: 'replicate',  name: 'Replicate' },
  { integrationId: 'stability',  name: 'Stability AI' },
]

/** Email sending: Resend → SendGrid */
export const EMAIL_PROVIDER_CHAIN: ProviderAttempt[] = [
  { integrationId: 'resend',    name: 'Resend' },
  { integrationId: 'sendgrid',  name: 'SendGrid' },
]

/** AI text generation: OpenAI → Anthropic */
export const AI_PROVIDER_CHAIN: ProviderAttempt[] = [
  { integrationId: 'openai',    name: 'OpenAI' },
  { integrationId: 'anthropic', name: 'Anthropic' },
]

// ── Core failover runner ──────────────────────────────────────────────────────

/**
 * Try providers in order. On error or unavailability, move to the next.
 * Returns the result from the first provider that succeeds.
 *
 * @param projectId    The project whose integration keys to use
 * @param chain        Ordered list of providers to try
 * @param executor     Async function that takes (providerKey, providerId) and returns T
 *                     Should throw or return null to signal failure
 */
export async function withFailover<T>(
  projectId: string,
  chain: ProviderAttempt[],
  executor: (key: string, providerId: string) => Promise<T | null>,
): Promise<FailoverResult<T>> {
  let lastError = ''
  let attemptCount = 0

  for (const provider of chain) {
    const key = await getIntegrationKey(projectId, provider.integrationId)
    if (!key) continue  // Not configured — skip to next

    attemptCount++
    try {
      const result = await executor(key, provider.integrationId)
      if (result !== null) {
        return {
          success: true,
          result,
          providerId: provider.integrationId,
          providerName: provider.name,
          attemptCount,
        }
      }
    } catch (err: any) {
      lastError = err.message || String(err)
      console.warn(`[Failover] Provider ${provider.name} failed: ${lastError} — trying next`)
    }
  }

  return {
    success: false,
    providerId: '',
    providerName: 'none',
    attemptCount,
    lastError: lastError || 'No providers configured or all failed',
  }
}

// ── Domain-specific helpers ───────────────────────────────────────────────────

/**
 * Execute a video generation request with automatic failover.
 *
 * Example:
 *   const result = await withVideoFailover(projectId, async (key, provider) => {
 *     if (provider === 'runway') return await callRunway(key, prompt)
 *     if (provider === 'replicate') return await callReplicate(key, prompt)
 *     return null
 *   })
 */
export async function withVideoFailover<T>(
  projectId: string,
  executor: (key: string, providerId: string) => Promise<T | null>,
): Promise<FailoverResult<T>> {
  return withFailover(projectId, VIDEO_PROVIDER_CHAIN, executor)
}

/**
 * Execute an email send with automatic failover.
 *
 * Example:
 *   const result = await withEmailFailover(projectId, async (key, provider) => {
 *     if (provider === 'resend') return await sendWithResend(key, payload)
 *     if (provider === 'sendgrid') return await sendWithSendGrid(key, payload)
 *     return null
 *   })
 */
export async function withEmailFailover<T>(
  projectId: string,
  executor: (key: string, providerId: string) => Promise<T | null>,
): Promise<FailoverResult<T>> {
  return withFailover(projectId, EMAIL_PROVIDER_CHAIN, executor)
}

/**
 * Execute an AI text-generation request with automatic failover.
 */
export async function withAiFailover<T>(
  projectId: string,
  executor: (key: string, providerId: string) => Promise<T | null>,
): Promise<FailoverResult<T>> {
  return withFailover(projectId, AI_PROVIDER_CHAIN, executor)
}

// ── Provider availability checker ─────────────────────────────────────────────

/**
 * Return which providers in a chain are configured for a project.
 * Useful for pre-flight checks before submitting a job.
 */
export async function getConfiguredProviders(
  projectId: string,
  chain: ProviderAttempt[],
): Promise<ProviderAttempt[]> {
  const configured: ProviderAttempt[] = []
  for (const provider of chain) {
    const key = await getIntegrationKey(projectId, provider.integrationId)
    if (key) configured.push(provider)
  }
  return configured
}

/**
 * Return a human-readable message describing failover configuration.
 * Used in error responses so users know what's available.
 */
export function describeFailoverState(
  configured: ProviderAttempt[],
  chain: ProviderAttempt[],
): string {
  if (configured.length === 0) {
    return `No providers configured. Available options: ${chain.map(p => p.name).join(', ')}.`
  }
  if (configured.length === 1) {
    return `Primary provider: ${configured[0].name}. Consider adding a fallback (${chain.filter(p => p.integrationId !== configured[0].integrationId).map(p => p.name).join(' or ')}).`
  }
  return `Failover chain active: ${configured.map(p => p.name).join(' → ')} (${configured.length}/${chain.length} providers configured).`
}
