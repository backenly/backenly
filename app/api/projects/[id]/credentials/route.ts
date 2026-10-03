export const dynamic = 'force-dynamic'

/**
 * POST /api/projects/[id]/credentials
 *
 * Accepts integration credentials from the CredentialModal, stores them
 * securely, then resumes any blocked build nodes that needed those keys.
 *
 * Request body:
 *   { integrationId: string, values: Record<string, string> }
 *
 * Response:
 *   { success, resumed, message, buildResponse? }
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { storeIntegrationKey } from '@/lib/services/integrationKeyStore'
import { prisma } from '@/lib/db/prisma'
import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'

// Maps env-var names (as used by CredentialModal) to canonical integration IDs
const ENV_TO_INTEGRATION: Record<string, string> = {
  STRIPE_SECRET_KEY:      'stripe',
  STRIPE_WEBHOOK_SECRET:  'stripe_webhook_secret',  // must match integrationKeyStore lookup
  RESEND_API_KEY:         'resend',
  SENDGRID_API_KEY:       'sendgrid',
  OPENAI_API_KEY:         'openai',
  ANTHROPIC_API_KEY:      'anthropic',
  POSTHOG_API_KEY:        'posthog',
  GOOGLE_CLIENT_ID:       'google',
  GOOGLE_CLIENT_SECRET:   'google',
  GITHUB_CLIENT_ID:       'github',
  GITHUB_CLIENT_SECRET:   'github',
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId, userId } = validated

    let body: { integrationId?: string; values?: Record<string, string> }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { integrationId, values } = body
    if (!integrationId || !values || Object.keys(values).length === 0) {
      return NextResponse.json(
        { error: 'integrationId and values are required' },
        { status: 400 }
      )
    }

    // ── 1. Store each key securely ────────────────────────────────────────────
    const stored: string[] = []
    for (const [envVar, rawKey] of Object.entries(values)) {
      const trimmed = rawKey?.trim()
      if (!trimmed) continue

      // Store under the canonical integration ID
      const canonicalId = ENV_TO_INTEGRATION[envVar] ?? integrationId
      try {
        await storeIntegrationKey(projectId, canonicalId, trimmed)
      } catch (err: any) {
        // Surface format/dangerous-secret errors as a proper 422 so the UI can
        // display the real message ("must start with sk_live_…") instead of a
        // generic 500 that comes from withProjectValidation's catch-all.
        return NextResponse.json(
          { error: err?.message ?? 'Failed to store credential' },
          { status: err?.isFormatError ? 422 : 400 }
        )
      }

      // Also store by env-var lowercase so the execute route can look it up.
      // Wrapped in try/catch: the canonical store above already succeeded; the alias
      // is a convenience lookup and must not fail the request if the env-var name
      // triggers a false-positive format validation (e.g. stripe_webhook_secret → stripe).
      const envKey = envVar.toLowerCase()
      if (envKey !== canonicalId) {
        try {
          await storeIntegrationKey(projectId, envKey, trimmed)
        } catch {
          // non-fatal — canonical key is already stored above
        }
      }

      stored.push(envVar)
    }

    if (stored.length === 0) {
      return NextResponse.json(
        { error: 'No valid credential values provided' },
        { status: 400 }
      )
    }

    // ── 2. Sync project.activeIntegrations so the dashboard reflects real state ─
    // The integrations page reads project.activeIntegrations[id].enabled.
    // Without this, the dashboard shows "Not provisioned" while the key IS stored.
    try {
      const existingProject = await prisma.project.findUnique({
        where: { id: projectId },
        select: { activeIntegrations: true },
      })
      const existing = (existingProject?.activeIntegrations as Record<string, any>) ?? {}
      if (!existing[integrationId]?.enabled) {
        await prisma.project.update({
          where: { id: projectId },
          data: {
            activeIntegrations: {
              ...existing,
              [integrationId]: {
                enabled: true,
                activatedAt: new Date().toISOString(),
                activatedBy: 'credential_modal',
                stored,
              },
            },
          },
        })
      }
    } catch {
      // non-fatal — dashboard sync is best-effort
    }

    // ── 4. For OAuth providers: wire ADD_PROVIDER + write directly to workspaceOAuthConfig ─
    // We do BOTH: executeAction (which also adds OAuth columns to users table)
    // AND a direct WorkspaceOAuthService.upsertConfig call so the Auth page can
    // reliably read the enabled state even if executeAction fails silently.
    if (integrationId === 'google' || integrationId === 'github') {
      const clientId     = values['GOOGLE_CLIENT_ID']     || values['GITHUB_CLIENT_ID']
      const clientSecret = values['GOOGLE_CLIENT_SECRET'] || values['GITHUB_CLIENT_SECRET']
      if (clientId && clientSecret) {
        // Direct write first — guaranteed to reach the DB
        try {
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'
          await WorkspaceOAuthService.upsertConfig(projectId, {
            provider: integrationId,
            clientId,
            clientSecret,
            redirectUri: `${baseUrl}/api/v1/${projectId}/auth/${integrationId}/callback`,
            scopes: [],
            enabled: true,
          })
        } catch {
          // non-fatal
        }
        // Also run ADD_PROVIDER to add OAuth columns to workspace users table
        try {
          const { executeAction } = await import('@/lib/ai/minimal-executor')
          const { withBuildLock } = await import('@/lib/ai/build-runtime/build-lock')
          await withBuildLock(projectId, 'modify', async () =>
            executeAction(
              { action: 'ADD_PROVIDER', params: { provider: integrationId, clientId, clientSecret } },
              projectId,
            ),
          )
        } catch {
          // non-fatal — columns may already exist
        }
        // Store the {provider}_auth vault marker so the readiness system can track this
        // integration. Without it, hasIntegrationKey(projectId, 'google_auth') returns false
        // and the integration always shows as "Not Connected" in readiness checks.
        try {
          await storeIntegrationKey(
            projectId,
            `${integrationId}_auth`,
            `configured:${new Date().toISOString()}`,
          )
        } catch {
          // non-fatal
        }
      }
    }

    // ── 5. Resume any blocked build job in the background ──────────────────────
    // The build resume can take 30+ seconds (executing nodes, verifying, etc.).
    // Return success immediately so the UI doesn't hang on "Saving & resuming…".
    // The build resume runs fire-and-forget; the chat/build-status APIs will
    // reflect the updated state once it completes.
    const label = integrationId.charAt(0).toUpperCase() + integrationId.slice(1)
    let message = `${label} credentials saved.`

    // Resume blocked build nodes and return the updated buildResponse so the UI
    // can remove the connected credential from the blocked list and show verification.
    let resumed = false
    let buildResponse: any = undefined
    try {
      const { hasActiveBuildJob, resumeAfterCredential } = await import('@/lib/ai/build-runtime')
      const hasBuildJob = await hasActiveBuildJob(projectId)
      if (hasBuildJob) {
        const result = await resumeAfterCredential(integrationId, {
          projectId,
          userId,
          emit: () => {},
        })
        resumed = result.resumed
        buildResponse = result.buildResponse
      }
    } catch (err) {
      console.error(`[credentials] Build resume failed for ${integrationId}:`, err)
      // Non-fatal — credentials are already saved; resume can be retried
    }

    return NextResponse.json({
      success: true,
      resumed,
      message,
      stored,
      buildResponse,
    })
  })
}
