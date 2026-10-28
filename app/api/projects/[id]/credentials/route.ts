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
import { governedChange } from '@/lib/changes/ledger'
import { storeIntegrationKey, vaultIdForEnvVar } from '@/lib/services/integrationKeyStore'
import { prisma } from '@/lib/db/prisma'
import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'

// Every provider the end-user OAuth runtime serves (server/routes/oauth.ts).
// A provider missing here saves its keys but never reaches workspaceOAuthConfig,
// so the runtime keeps answering "not configured" — the AUTH-F7 failure mode.
const OAUTH_PROVIDERS = ['google', 'github', 'discord', 'facebook']

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
    // Steps 1 and 2 are one change in the project's history: the keys and the
    // switch that says the integration is connected (lib/changes/resources).
    const stored: string[] = []
    let refused = null as NextResponse | null
    const connect = async () => {
      for (const [envVar, rawKey] of Object.entries(values)) {
        const trimmed = rawKey?.trim()
        if (!trimmed) continue

        // One row, under the vault id every reader looks up. This used to write
        // a second row under the lowercased env-var name, which listed as its
        // own integration and kept Stripe connected after a disconnect; a lookup
        // by env-var name now resolves to this row inside the key store.
        const vaultId = vaultIdForEnvVar(envVar) ?? integrationId
        try {
          await storeIntegrationKey(projectId, vaultId, trimmed)
        } catch (err: any) {
          // Surface format/dangerous-secret errors as a proper 422 so the UI can
          // display the real message ("must start with sk_live_…") instead of a
          // generic 500 that comes from withProjectValidation's catch-all.
          refused = NextResponse.json(
            { error: err?.message ?? 'Failed to store credential' },
            { status: err?.isFormatError ? 422 : 400 }
          )
          return
        }

        stored.push(envVar)
      }

      if (stored.length === 0) return

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
          // history: inside the Connect change above
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
    }
    await governedChange(projectId, `Connect ${integrationId}`, connect)
    if (refused) return refused
    if (stored.length === 0) {
      return NextResponse.json(
        { error: 'No valid credential values provided' },
        { status: 400 }
      )
    }

    // ── 4. For OAuth providers: wire ADD_PROVIDER + write directly to workspaceOAuthConfig ─
    // We do BOTH: executeAction (which also adds OAuth columns to users table)
    // AND a direct WorkspaceOAuthService.upsertConfig call so the Auth page can
    // reliably read the enabled state even if executeAction fails silently.
    if (OAUTH_PROVIDERS.includes(integrationId)) {
      const envPrefix    = integrationId.toUpperCase()
      const clientId     = values[`${envPrefix}_CLIENT_ID`]
      const clientSecret = values[`${envPrefix}_CLIENT_SECRET`]
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
