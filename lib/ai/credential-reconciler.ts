/**
 * CREDENTIAL RECONCILER
 * =====================
 * Resolves the mismatch between:
 *   1. Connected credentials (stored in ProjectIntegrationKey / WorkspaceOAuthConfig)
 *   2. Blocked BuildJob nodes (still marked blocked despite credentials being present)
 *   3. Dashboard/inspector status (showing stale "credential needed" state)
 *
 * Problem this solves:
 *   User connects Google OAuth → integration page shows "connected"
 *   Dashboard still shows "1 credential needed"
 *   Build job still has google node marked as blocked
 *
 * reconcileBlockedCredentials() is the single source of truth for unblocking.
 * Call it:
 *   - After every credential save
 *   - Before every build status response
 *   - Before dashboard summary render
 *   - Before /scan proof section
 *   - Before resume build
 *   - After stop/cancel
 */

import { prisma } from '@/lib/db/prisma'
import { loadActiveBuildJob, saveBuildJob, syncAgentStateBlockedIntegrations } from '@/lib/ai/build-runtime/continuation-store'
import { graphFromJob } from '@/lib/ai/build-runtime/build-graph'
import type { BuildNode } from '@/lib/ai/build-runtime/types'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ReconciliationResult {
  /** Node IDs that were unblocked */
  unblockedNodes: string[]
  /** Integration IDs that were resolved */
  resolvedIntegrations: string[]
  /** Integration IDs still blocked (credential genuinely missing) */
  remainingBlockers: Array<{
    name: string
    type: string
    requiredEnvVar?: string
    provider?: string
  }>
  /** Whether any state was changed */
  changed: boolean
}

// ── Integration → EnvVar mapping ─────────────────────────────────────────────

const INTEGRATION_ENV_MAP: Record<string, string[]> = {
  stripe:     ['STRIPE_SECRET_KEY'],
  resend:     ['RESEND_API_KEY'],
  sendgrid:   ['SENDGRID_API_KEY'],
  openai:     ['OPENAI_API_KEY'],
  anthropic:  ['ANTHROPIC_API_KEY'],
  google:     ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  github:     ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  replicate:  ['REPLICATE_API_TOKEN'],
  posthog:    ['POSTHOG_API_KEY'],
  twilio:     ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  cloudinary: ['CLOUDINARY_API_KEY'],
  pusher:     ['PUSHER_APP_KEY'],
  razorpay:   ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'],
}

// ── Source of truth readers ───────────────────────────────────────────────────

async function loadConnectedIntegrations(projectId: string): Promise<Set<string>> {
  const connected = new Set<string>()
  try {
    // 1. ProjectIntegrationKey (API keys: Stripe, Resend, OpenAI, etc.)
    const keys = await prisma.projectIntegrationKey.findMany({
      where: { projectId },
      select: { integrationId: true },
    })
    for (const k of keys) connected.add(k.integrationId.toLowerCase())
  } catch { /* non-fatal */ }

  try {
    // 2. WorkspaceOAuthConfig (Google, GitHub OAuth)
    const oauthConfigs = await prisma.workspaceOAuthConfig.findMany({
      where: { projectId },
      select: { provider: true },
    })
    for (const o of oauthConfigs) connected.add(o.provider.toLowerCase())
  } catch { /* non-fatal */ }

  try {
    // 3. ProviderCredential (encrypted credentials)
    const creds = await prisma.providerCredential.findMany({
      where: { projectId },
      select: { provider: true },
    })
    for (const c of creds) connected.add(c.provider.toLowerCase())
  } catch { /* non-fatal */ }

  return connected
}

// ── Main reconciliation function ─────────────────────────────────────────────

/**
 * Reconcile blocked credentials against the real credential store.
 * Unblocks any build nodes whose required credentials are now present.
 * Returns a detailed breakdown of remaining vs. resolved blockers.
 */
export async function reconcileBlockedCredentials(projectId: string): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    unblockedNodes: [],
    resolvedIntegrations: [],
    remainingBlockers: [],
    changed: false,
  }

  const job = await loadActiveBuildJob(projectId)
  if (!job) return result

  const connected = await loadConnectedIntegrations(projectId)
  if (connected.size === 0) {
    // No credentials at all — report remaining blockers from job
    const allBlockedNodes = job.phases.flatMap(p => p.nodes).filter(n => n.status === 'blocked')
    for (const node of allBlockedNodes) {
      result.remainingBlockers.push({
        name: node.label,
        type: node.type,
        requiredEnvVar: node.blockedReason?.requiredEnvVar,
        provider: node.blockedReason?.resumeOnIntegration,
      })
    }
    return result
  }

  const graph = graphFromJob(job)
  const allNodes = graph.getAllNodes()
  const blockedNodes = allNodes.filter(n => n.status === 'blocked')

  for (const node of blockedNodes) {
    const integrationId = node.blockedReason?.resumeOnIntegration
    const requiredEnvVar = node.blockedReason?.requiredEnvVar

    if (!integrationId && !requiredEnvVar) {
      // Manual step — can't auto-resolve
      result.remainingBlockers.push({ name: node.label, type: node.type })
      continue
    }

    const isConnected = integrationId
      ? connected.has(integrationId.toLowerCase())
      : requiredEnvVar
        ? isEnvVarSatisfied(requiredEnvVar, connected)
        : false

    if (isConnected) {
      // Unblock this node
      graph.setStatus(node.id, 'pending')
      result.unblockedNodes.push(node.id)
      if (integrationId && !result.resolvedIntegrations.includes(integrationId)) {
        result.resolvedIntegrations.push(integrationId)
      }
      result.changed = true
    } else {
      result.remainingBlockers.push({
        name: node.label,
        type: node.type,
        requiredEnvVar: requiredEnvVar,
        provider: integrationId,
      })
    }
  }

  if (result.changed) {
    // Sync graph state back to job and persist
    job.phases = graph.toJSON()
    if (result.remainingBlockers.length === 0 && job.status === 'blocked') {
      job.status = 'partial'
    }
    job.updatedAt = new Date().toISOString()
    await saveBuildJob(job)

    // Sync dashboard state
    try {
      await syncAgentStateBlockedIntegrations(
        projectId,
        result.remainingBlockers.map(b => ({
          id: b.provider ?? b.requiredEnvVar ?? b.name,
          label: b.name,
          blockedReason: {
            resumeOnIntegration: b.provider,
            description: `${b.name} credentials required`,
            requiredEnvVar: b.requiredEnvVar,
          },
        }))
      )
    } catch { /* non-fatal */ }
  }

  return result
}

/**
 * Get a human-readable list of missing credentials for this project.
 * Used by dashboard, inspector, and /scan to show specific names, not generic counts.
 */
export async function getMissingCredentials(projectId: string): Promise<Array<{
  name: string
  envVar?: string
  provider?: string
  hint: string
}>> {
  const result = await reconcileBlockedCredentials(projectId)
  return result.remainingBlockers.map(b => ({
    name: b.name,
    envVar: b.requiredEnvVar,
    provider: b.provider,
    hint: buildCredentialHint(b.provider ?? b.requiredEnvVar ?? b.name),
  }))
}

function buildCredentialHint(identifier: string): string {
  const id = identifier.toLowerCase()
  if (id.includes('stripe')) return 'Stripe Secret Key (sk_test_… or sk_live_…)'
  if (id.includes('resend')) return 'Resend API Key (re_…)'
  if (id.includes('google')) return 'Google OAuth credentials (Client ID + Client Secret)'
  if (id.includes('github')) return 'GitHub OAuth credentials (Client ID + Client Secret)'
  if (id.includes('openai')) return 'OpenAI API Key (sk-…)'
  if (id.includes('anthropic')) return 'Anthropic API Key (sk-ant-…)'
  if (id.includes('sendgrid')) return 'SendGrid API Key (SG.…)'
  if (id.includes('webhook') || id.includes('whsec')) return 'Stripe Webhook Secret (whsec_…)'
  if (id.includes('posthog')) return 'PostHog Project API Key'
  return `${identifier} credential`
}

function isEnvVarSatisfied(envVar: string, connected: Set<string>): boolean {
  // Check if the integration that provides this env var is connected
  for (const [integrationId, envVars] of Object.entries(INTEGRATION_ENV_MAP)) {
    if (envVars.includes(envVar) && connected.has(integrationId)) return true
  }
  return false
}

// ── Post-credential-save hook ─────────────────────────────────────────────────

/**
 * Called after any credential is stored.
 * Runs reconciliation and emits events to update dashboard/inspector.
 */
export async function onCredentialSaved(
  projectId: string,
  integrationId: string,
): Promise<ReconciliationResult> {
  const result = await reconcileBlockedCredentials(projectId)

  if (result.changed) {
    // Emit build.status.changed event so dashboard updates without refresh
    try {
      const { prisma: _prisma } = await import('@/lib/db/prisma')
      await _prisma.project.update({
        where: { id: projectId },
        data: { updatedAt: new Date() },
      })
    } catch { /* non-fatal */ }
  }

  return result
}
