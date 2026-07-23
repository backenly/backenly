/**
 * VIDEO PROVIDER INTEGRATION EXECUTOR
 * =====================================
 * Handles Runway ML, Stability AI, Replicate, Kling (via Replicate), and Pika Labs.
 * Stores the API key, runs a live API health check, and records the integration.
 */

import { storeIntegrationKey } from '@/lib/services/integrationKeyStore'
import { getCircuitBreaker, CircuitOpenError } from '@/lib/services/circuit-breaker'
import type { DispatchResult } from './index'

interface VideoProviderConfig {
  displayName: string
  integrationId: string
  /** Endpoint to ping for key validation (null = skip live check) */
  healthEndpoint: string | null
  /** How to build the Authorization header */
  authHeader: (key: string) => string
  /** Expected success status range */
  successStatuses: number[]
  /** Human-readable key format hint */
  keyFormat: string
  /** Docs URL */
  docsUrl: string
}

const VIDEO_PROVIDER_CONFIGS: Record<string, VideoProviderConfig> = {
  runway: {
    displayName: 'Runway ML',
    integrationId: 'runway',
    healthEndpoint: 'https://api.dev.runwayml.com/v1/assets',
    authHeader: (k) => `Bearer ${k}`,
    successStatuses: [200, 201, 204],
    keyFormat: 'key_...',
    docsUrl: 'app.runwayml.com/settings',
  },
  stability: {
    displayName: 'Stability AI',
    integrationId: 'stability',
    healthEndpoint: 'https://api.stability.ai/v1/user/account',
    authHeader: (k) => `Bearer ${k}`,
    successStatuses: [200],
    keyFormat: 'sk-... (40+ chars)',
    docsUrl: 'platform.stability.ai/account/keys',
  },
  replicate: {
    displayName: 'Replicate',
    integrationId: 'replicate',
    healthEndpoint: 'https://api.replicate.com/v1/account',
    authHeader: (k) => `Token ${k}`,
    successStatuses: [200],
    keyFormat: 'r8_...',
    docsUrl: 'replicate.com/account/api-tokens',
  },
  // Kling runs on Replicate — same key, stored under 'replicate' integrationId
  kling: {
    displayName: 'Kling (via Replicate)',
    integrationId: 'replicate',
    healthEndpoint: 'https://api.replicate.com/v1/account',
    authHeader: (k) => `Token ${k}`,
    successStatuses: [200],
    keyFormat: 'r8_... (Replicate token)',
    docsUrl: 'replicate.com/account/api-tokens',
  },
  pika: {
    displayName: 'Pika Labs',
    integrationId: 'pika',
    healthEndpoint: null, // No public health endpoint yet
    authHeader: (k) => `Bearer ${k}`,
    successStatuses: [200],
    keyFormat: 'pika_...',
    docsUrl: 'pika.art/developers',
  },
}

export async function executeVideoProviderIntegration(
  projectId: string,
  provider: string,
  apiKey: string,
): Promise<DispatchResult> {
  const config = VIDEO_PROVIDER_CONFIGS[provider]
  if (!config) {
    return { success: false, message: `Unknown video provider: ${provider}` }
  }

  if (!apiKey || apiKey.length < 8) {
    return {
      success: false,
      message: `Failed: ${config.displayName} API key is too short. Expected format: \`${config.keyFormat}\``,
    }
  }

  // Live API health check — protected by a circuit breaker per provider
  let liveValid = true
  let liveNote = ''

  if (config.healthEndpoint) {
    const cb = getCircuitBreaker(provider, { failureThreshold: 3, resetTimeoutMs: 60_000 })
    try {
      const res = await cb.execute(() =>
        fetch(config.healthEndpoint!, {
          method: 'GET',
          headers: {
            Authorization: config.authHeader(apiKey),
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(8_000), // 8s fetch timeout
        })
      )
      if (res.status === 401 || res.status === 403) {
        return {
          success: false,
          message: `Failed: ${config.displayName} rejected this key (HTTP ${res.status}). Check your key at ${config.docsUrl} and try again.`,
        }
      }
      if (!config.successStatuses.includes(res.status)) {
        // Non-auth error (503, etc.) — store key anyway, note the warning
        liveValid = false
        liveNote = `\n⚠️ ${config.displayName} API returned ${res.status} during validation — key stored, verify manually.`
      } else {
        liveNote = `\n✅ ${config.displayName} API: key verified.`
      }
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        liveNote = `\n⚠️ ${config.displayName} API is temporarily unavailable (circuit open, retry in ${err.retryAfterSec}s) — key stored, verify manually.`
      } else {
        liveNote = `\n⚠️ Could not reach ${config.displayName} API to verify — key stored, verify manually.`
      }
    }
  }

  // Persist the key using the standard key store (encrypted at rest)
  try {
    await storeIntegrationKey(projectId, config.integrationId, apiKey)
  } catch (err: any) {
    return {
      success: false,
      message: `Failed: could not store ${config.displayName} key — ${err.message}`,
    }
  }

  return {
    success: true,
    message: [
      `Done: ${config.displayName} connected.${liveNote}`,
      '',
      'Your video generation pipeline is now active. Jobs submitted to the `generation_jobs` table will be routed to ' + config.displayName + ' automatically.',
    ].join('\n'),
    data: { integrationId: config.integrationId, provider },
  }
}
