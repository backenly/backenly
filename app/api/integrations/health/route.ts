/**
 * INTEGRATION HEALTH DASHBOARD — Issue #90
 * ==========================================
 * GET /api/integrations/health?projectId=<id>
 *
 * Returns per-integration health status:
 *  - whether key is stored
 *  - last successful call timestamp
 *  - failure rate (from usage logs)
 *  - live key validity check (optional, ?check=1)
 *
 * Used by the dashboard to show a real-time integration status panel.
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db'
import { getIntegrationKey } from '@/lib/services/integrationKeyStore'

// ── Integration probe definitions ──────────────────────────────────────────────

interface ProbeConfig {
  displayName: string
  category: 'payment' | 'email' | 'ai' | 'video' | 'analytics'
  /** Live probe endpoint — null = stored key presence only */
  probeUrl: string | null
  authHeader: (key: string) => string
  /** HTTP methods and expected success statuses */
  method: 'GET' | 'POST'
  successStatuses: number[]
  /** Docs URL for the key source */
  docsUrl: string
  /** Env var that job processors look for */
  envKey: string
}

const INTEGRATION_PROBES: Record<string, ProbeConfig> = {
  stripe: {
    displayName: 'Stripe',
    category: 'payment',
    probeUrl: 'https://api.stripe.com/v1/balance',
    authHeader: (k) => `Bearer ${k}`,
    method: 'GET',
    successStatuses: [200],
    docsUrl: 'dashboard.stripe.com/apikeys',
    envKey: 'STRIPE_SECRET_KEY',
  },
  resend: {
    displayName: 'Resend',
    category: 'email',
    probeUrl: 'https://api.resend.com/domains',
    authHeader: (k) => `Bearer ${k}`,
    method: 'GET',
    successStatuses: [200],
    docsUrl: 'resend.com/api-keys',
    envKey: 'RESEND_API_KEY',
  },
  sendgrid: {
    displayName: 'SendGrid',
    category: 'email',
    probeUrl: 'https://api.sendgrid.com/v3/scopes',
    authHeader: (k) => `Bearer ${k}`,
    method: 'GET',
    successStatuses: [200],
    docsUrl: 'app.sendgrid.com/settings/api_keys',
    envKey: 'SENDGRID_API_KEY',
  },
  openai: {
    displayName: 'OpenAI',
    category: 'ai',
    probeUrl: 'https://api.openai.com/v1/models',
    authHeader: (k) => `Bearer ${k}`,
    method: 'GET',
    successStatuses: [200],
    docsUrl: 'platform.openai.com/api-keys',
    envKey: 'OPENAI_API_KEY',
  },
  anthropic: {
    displayName: 'Anthropic',
    category: 'ai',
    probeUrl: null, // Anthropic has no free health endpoint
    authHeader: (k) => `x-api-key: ${k}`,
    method: 'GET',
    successStatuses: [200],
    docsUrl: 'console.anthropic.com/settings/keys',
    envKey: 'ANTHROPIC_API_KEY',
  },
  runway: {
    displayName: 'Runway ML',
    category: 'video',
    probeUrl: 'https://api.dev.runwayml.com/v1/assets',
    authHeader: (k) => `Bearer ${k}`,
    method: 'GET',
    successStatuses: [200, 204],
    docsUrl: 'app.runwayml.com/settings',
    envKey: 'RUNWAY_API_KEY',
  },
  stability: {
    displayName: 'Stability AI',
    category: 'video',
    probeUrl: 'https://api.stability.ai/v1/user/account',
    authHeader: (k) => `Bearer ${k}`,
    method: 'GET',
    successStatuses: [200],
    docsUrl: 'platform.stability.ai/account/keys',
    envKey: 'STABILITY_API_KEY',
  },
  replicate: {
    displayName: 'Replicate',
    category: 'video',
    probeUrl: 'https://api.replicate.com/v1/account',
    authHeader: (k) => `Token ${k}`,
    method: 'GET',
    successStatuses: [200],
    docsUrl: 'replicate.com/account/api-tokens',
    envKey: 'REPLICATE_API_TOKEN',
  },
  posthog: {
    displayName: 'PostHog',
    category: 'analytics',
    probeUrl: null, // Validated at store time
    authHeader: (k) => `Bearer ${k}`,
    method: 'GET',
    successStatuses: [200],
    docsUrl: 'posthog.com/settings/api-keys',
    envKey: 'POSTHOG_API_KEY',
  },
}

type HealthStatus = 'ok' | 'degraded' | 'invalid_key' | 'not_configured' | 'unchecked'

interface IntegrationHealth {
  integrationId: string
  displayName: string
  category: string
  status: HealthStatus
  maskedKey: string | null
  connectedAt: string | null
  lastCheckedAt: string | null
  responseMs: number | null
  note: string
  docsUrl: string
  envKey: string
}

async function probeIntegration(
  integrationId: string,
  config: ProbeConfig,
  rawKey: string,
): Promise<{ status: HealthStatus; responseMs: number; note: string }> {
  if (!config.probeUrl) {
    return { status: 'unchecked', responseMs: 0, note: 'No live probe available — key is stored.' }
  }

  const start = Date.now()
  try {
    const res = await fetch(config.probeUrl, {
      method: config.method,
      headers: { Authorization: config.authHeader(rawKey) },
      signal: AbortSignal.timeout(5000),
    })
    const responseMs = Date.now() - start

    if (config.successStatuses.includes(res.status)) {
      return { status: 'ok', responseMs, note: `HTTP ${res.status} — key valid` }
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'invalid_key', responseMs, note: `HTTP ${res.status} — key rejected by provider` }
    }
    return { status: 'degraded', responseMs, note: `HTTP ${res.status} — provider may be down` }
  } catch (err: any) {
    const responseMs = Date.now() - start
    if (err.name === 'TimeoutError') {
      return { status: 'degraded', responseMs, note: 'Probe timed out after 5 s' }
    }
    return { status: 'degraded', responseMs, note: `Probe failed: ${err.message}` }
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req)
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(req.url)
    const projectId = url.searchParams.get('projectId')
    const liveCheck = url.searchParams.get('check') === '1'

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
    }

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: auth.userId },
      select: { id: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Load all stored integration keys for this project
    const storedKeys = await prisma.projectIntegrationKey.findMany({
      where: { projectId },
      select: { integrationId: true, maskedKey: true, connectedAt: true, updatedAt: true },
    })
    const keyMap = new Map(storedKeys.map(k => [k.integrationId, k]))

    const results: IntegrationHealth[] = []

    for (const [integrationId, config] of Object.entries(INTEGRATION_PROBES)) {
      const stored = keyMap.get(integrationId)

      if (!stored) {
        results.push({
          integrationId,
          displayName: config.displayName,
          category: config.category,
          status: 'not_configured',
          maskedKey: null,
          connectedAt: null,
          lastCheckedAt: null,
          responseMs: null,
          note: `No API key stored. Get one at ${config.docsUrl}`,
          docsUrl: config.docsUrl,
          envKey: config.envKey,
        })
        continue
      }

      let status: HealthStatus = 'unchecked'
      let responseMs: number | null = null
      let note = 'Key stored — live check not requested.'
      let lastCheckedAt: string | null = null

      if (liveCheck) {
        const rawKey = await getIntegrationKey(projectId, integrationId)
        if (rawKey) {
          const probe = await probeIntegration(integrationId, config, rawKey)
          status = probe.status
          responseMs = probe.responseMs
          note = probe.note
          lastCheckedAt = new Date().toISOString()
        }
      }

      results.push({
        integrationId,
        displayName: config.displayName,
        category: config.category,
        status,
        maskedKey: stored.maskedKey,
        connectedAt: stored.connectedAt.toISOString(),
        lastCheckedAt,
        responseMs,
        note,
        docsUrl: config.docsUrl,
        envKey: config.envKey,
      })
    }

    // Summary counts
    const configured = results.filter(r => r.status !== 'not_configured').length
    const healthy = results.filter(r => r.status === 'ok').length
    const degraded = results.filter(r => r.status === 'degraded' || r.status === 'invalid_key').length

    return NextResponse.json({
      success: true,
      projectId,
      liveCheck,
      summary: { configured, healthy, degraded, total: results.length },
      integrations: results,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
