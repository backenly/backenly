/**
 * AUTH INTEGRATION EXECUTOR
 * ==========================
 * Configures Google / GitHub OAuth with full readiness tracking.
 *
 * States produced:
 *   not_configured    → No credentials stored.
 *   key_stored        → (not applicable — we go straight to partially_configured on success)
 *   partially_configured → Credentials stored + OAuth routes active.
 *                          External step pending: register callback URL in provider console.
 *   behaviorally_ready   → Credentials stored + callback registered externally
 *                          (inferred: treated as ready once creds are stored, since we
 *                          cannot verify the external registration programmatically).
 *
 * Behavioral chain:
 *   1. Require client ID + client secret
 *   2. Call ADD_PROVIDER → writes to WorkspaceOAuthConfig + adds OAuth columns to users table
 *   3. Store a marker key in the vault (so the readiness system can track this integration)
 *   4. Persist readiness to project.activeIntegrations
 *   5. Return clear message: what was done + what's externally pending + callback URL
 */

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { storeIntegrationKey } from '@/lib/services/integrationKeyStore'
import {
  checkIntegrationReadiness,
  toIntegrationRecord,
  formatReadinessReport,
} from './readiness'

export interface AuthIntegrationResult {
  success: boolean
  message: string
  needsCredentials?: boolean
  credentialHint?: string
  readiness?: string
}

export type AuthProvider = 'google' | 'github'

// Provider-specific external console paths
const PROVIDER_META: Record<AuthProvider, {
  label: string
  credSource: string
  callbackRegistrationPath: string
}> = {
  google: {
    label: 'Google',
    credSource: 'Google Cloud Console → APIs & Services → Credentials → Create OAuth 2.0 Client ID',
    callbackRegistrationPath: 'Google Cloud Console → Credentials → your OAuth Client → Authorized redirect URIs',
  },
  github: {
    label: 'GitHub',
    credSource: 'github.com/settings/applications/new → create an OAuth App',
    callbackRegistrationPath: 'github.com/settings/applications → your OAuth App → Authorization callback URL',
  },
}

export async function executeAuthIntegration(
  projectId: string,
  provider: AuthProvider,
  clientId?: string,
  clientSecret?: string,
): Promise<AuthIntegrationResult> {
  const meta = PROVIDER_META[provider]
  const integrationId = `${provider}_auth`
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://backenly.com'
  const callbackUrl = `${baseUrl}/api/v1/${projectId}/auth/${provider}/callback`

  // ── Require credentials ───────────────────────────────────────────────────
  if (!clientId || !clientSecret) {
    return {
      success: false,
      needsCredentials: true,
      message: [
        `**${meta.label} OAuth credentials required.**`,
        '',
        `Get your credentials from: ${meta.credSource}`,
        '',
        `**Callback URL to register in ${meta.callbackRegistrationPath}:**`,
        `\`${callbackUrl}\``,
        '',
        `Once you have the Client ID and Secret, paste them and I will complete the setup.`,
      ].join('\n'),
      credentialHint: `Paste your ${meta.label} Client ID and Client Secret.`,
    }
  }

  // ── Configure provider via minimal executor ───────────────────────────────
  // Writes to WorkspaceOAuthConfig + adds OAuth columns to workspace users table
  const result = await executeAction({
    action: 'ADD_PROVIDER',
    params: { provider, clientId, clientSecret },
  }, projectId)

  if (!result.success) {
    return {
      success: false,
      message: `Failed to configure ${meta.label} auth: ${result.message}`,
    }
  }

  // ── Store marker key in vault (enables readiness system tracking) ─────────
  // Value is not a real API key — it's a timestamped config marker.
  await storeIntegrationKey(
    projectId,
    integrationId,
    `configured:${new Date().toISOString()}`,
  ).catch(() => {})

  // ── Compute readiness + persist to activeIntegrations ────────────────────
  const readinessReport = await checkIntegrationReadiness(projectId, integrationId).catch(() => null)

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
        [integrationId]: readinessReport
          ? toIntegrationRecord(readinessReport, {
              activatedAt: existing[integrationId]?.activatedAt ?? new Date().toISOString(),
              activatedBy: 'integration_executor',
              provider,
              callbackUrl,
            })
          : {
              enabled: true,
              readiness: 'partially_configured',
              activatedAt: new Date().toISOString(),
              activatedBy: 'integration_executor',
              provider,
              callbackUrl,
            },
      },
    },
  })

  const readinessLine = readinessReport
    ? `\n\n${formatReadinessReport(readinessReport)}`
    : ''

  // ── Build response message ─────────────────────────────────────────────────
  return {
    success: true,
    readiness: readinessReport?.status ?? 'partially_configured',
    message: [
      `**${meta.label} OAuth configured.**`,
      '',
      `✅ Credentials stored securely`,
      `✅ OAuth routes active:`,
      `  - \`GET /api/v1/${projectId}/auth/${provider}\` — Redirects user to ${meta.label} login`,
      `  - \`GET /api/v1/${projectId}/auth/${provider}/callback\` — Handles OAuth callback`,
      `✅ OAuth columns added to workspace users table (oauth_provider, oauth_id, avatar_url)`,
      '',
      `⚠️ **External step required (cannot be done automatically):**`,
      `Register this callback URL in ${meta.callbackRegistrationPath}:`,
      `\`${callbackUrl}\``,
      `Logins will be rejected by ${meta.label} until this is registered.`,
      '',
      `**Status: Partially Configured** — credentials stored, awaiting external callback registration.`,
      `${meta.label} OAuth is verified on first successful user sign-in.`,
      readinessLine,
    ].join('\n'),
  }
}
