/**
 * INTEGRATION DEPENDENCY VALIDATOR + READINESS CHECKER
 * ======================================================
 * Defines the 3-state readiness model for each integration:
 *
 *   key_stored          → API key is in the vault; nothing else is done.
 *                         The integration is NOT active — it just means the
 *                         developer stored credentials.
 *
 *   partially_configured → Key + support tables exist, but required follow-up
 *                          work is incomplete (missing webhook secret, routes
 *                          not generated, triggers not created, etc.).
 *
 *   behaviorally_ready   → Every dependency is satisfied: key + tables +
 *                          generated routes/triggers.  The integration is
 *                          doing something meaningful end-to-end.
 *
 * This replaces the old "enabled: true" pattern that falsely claimed
 * integrations were active after only storing a key.
 */

import { prisma } from '@/lib/db/prisma'
import { hasIntegrationKey } from '@/lib/services/integrationKeyStore'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReadinessStatus =
  | 'key_stored'           // credentials exist; nothing else done
  | 'partially_configured' // partially wired; blockers remain
  | 'behaviorally_ready'   // fully wired; integration is operational

export interface IntegrationReadinessReport {
  integrationId: string
  status: ReadinessStatus
  /** Short human-readable label */
  label: string
  /** List of things that must be resolved to reach behaviorally_ready */
  blocking: string[]
  /** List of things that are already satisfied */
  satisfied: string[]
  /**
   * Optional additions that unlock more behaviour. NEVER blockers — an
   * integration is "Complete" without any of them. Kept separate so a store
   * that sells one-off items is not told it is misconfigured for lacking a
   * `subscriptions` table.
   */
  suggestions: string[]
  /** Ordered next steps the developer should take */
  nextSteps: string[]
}

// ── Per-integration dependency specs ─────────────────────────────────────────

interface DependencySpec {
  /** Human-friendly name used in messages */
  description: string
  /** All integration key IDs that must exist in the vault */
  requiredKeys: string[]
  /**
   * Workspace tables WITHOUT WHICH THE WIRED FUNCTIONS CANNOT RUN.
   *
   * Almost always empty, and that is the point. This list used to hold each
   * provider's full opinionated table set, so a plain one-time-purchase shop
   * could never reach "configured": it was blocked on a `subscriptions` table it
   * has no use for, and a `payment_events` audit table Stripe already keeps.
   *
   * A readiness gate that demands tables the product does not need is not
   * measuring readiness — it is asserting an architecture. Anything the
   * integration merely BENEFITS from belongs in `suggestedTables`.
   */
  requiredTables: string[]
  /**
   * Tables that unlock extra behaviour when present. Reported as suggestions,
   * never as blockers, and each says what it is FOR so the developer can decide
   * whether their product wants it.
   */
  suggestedTables?: Array<{ name: string; unlocks: string }>
  /** AiFunction.name substrings — at least one function matching each pattern must exist */
  requiredFunctionPatterns: string[]
}

const DEPENDENCY_SPECS: Record<string, DependencySpec> = {
  stripe: {
    description: 'Stripe Payments',
    // The key and the signing secret are genuinely required: without the secret
    // the receiver rejects every inbound event, which is a real broken state.
    requiredKeys: ['stripe', 'stripe_webhook_secret'],
    requiredTables: [],
    suggestedTables: [
      { name: 'subscriptions', unlocks: 'recurring billing — only if you sell subscriptions. A one-time-purchase store does not need it.' },
      { name: 'payment_events', unlocks: 'a local audit trail of Stripe events. Stripe keeps its own; this is for querying them alongside your data.' },
    ],
    requiredFunctionPatterns: ['stripe-checkout-session', 'stripe-webhook'],
  },
  resend: {
    description: 'Resend Email',
    requiredKeys: ['resend'],
    requiredTables: [],
    suggestedTables: [{ name: 'email_events', unlocks: 'delivery/open tracking stored in your own schema.' }],
    // send-transactional-email is always created; welcome-email is only created when auth is enabled
    requiredFunctionPatterns: ['send-transactional-email'],
  },
  openai: {
    description: 'OpenAI',
    requiredKeys: ['openai'],
    requiredTables: [],
    suggestedTables: [{ name: 'ai_responses', unlocks: 'logging completions for cost tracking or replay.' }],
    requiredFunctionPatterns: ['openai-chat'],
  },
  twilio: {
    description: 'Twilio SMS',
    requiredKeys: ['twilio'],
    requiredTables: [],
    suggestedTables: [{ name: 'sms_events', unlocks: 'delivery-status history for sent messages.' }],
    requiredFunctionPatterns: [],
  },
  // Google / GitHub OAuth — credentials are stored as a marker key in the vault
  // (the actual OAuth config lives in WorkspaceOAuthConfig).
  // behaviorally_ready means: credentials stored + OAuth routes are active.
  // External step (registering callback URL) is documented but cannot be verified here.
  google_auth: {
    description: 'Google OAuth',
    requiredKeys: ['google_auth'],
    requiredTables: [],
    requiredFunctionPatterns: [],
  },
  github_auth: {
    description: 'GitHub OAuth',
    requiredKeys: ['github_auth'],
    requiredTables: [],
    requiredFunctionPatterns: [],
  },
  posthog: {
    description: 'PostHog Analytics',
    requiredKeys: ['posthog'],
    requiredTables: [],
    suggestedTables: [{ name: 'analytics_events', unlocks: 'mirroring captured events into your own schema for SQL queries.' }],
    requiredFunctionPatterns: ['posthog-capture', 'posthog-identify'],
  },
}

/**
 * Test seam — asserted by tests/unit/agent-surface-honesty.spec.ts, which keeps
 * `requiredTables` from quietly re-acquiring an opinion about what a product
 * must be built from.
 */
export const __DEPENDENCY_SPECS = DEPENDENCY_SPECS

// ── Core checker ──────────────────────────────────────────────────────────────

export async function checkIntegrationReadiness(
  projectId: string,
  integrationId: string,
): Promise<IntegrationReadinessReport> {
  const spec = DEPENDENCY_SPECS[integrationId]

  // Unknown integration type — return minimal report
  if (!spec) {
    const keyPresent = await hasIntegrationKey(projectId, integrationId)
    return {
      integrationId,
      status: 'key_stored',
      label: keyPresent ? 'Partial' : 'Not Connected',
      blocking: [],
      satisfied: keyPresent ? ['API key stored'] : [],
      suggestions: [],
      nextSteps: [],
    }
  }

  const blocking: string[] = []
  const satisfied: string[] = []

  // 1. Required vault keys
  for (const keyId of spec.requiredKeys) {
    const exists = await hasIntegrationKey(projectId, keyId)
    if (exists) {
      if (keyId.includes('webhook_secret')) {
        satisfied.push(`${spec.description} webhook secret stored`)
      } else if (keyId === integrationId) {
        // Read the credential's REAL verification state, recorded when the
        // provider was asked at connect time. This used to look for a
        // `${keyId}_key_verified` marker key that nothing ever wrote, so every
        // credential reported "stored (not yet live-verified)" regardless of
        // whether it had been confirmed. See lib/integrations/key-verification.
        const record = await prisma.projectIntegrationKey.findFirst({
          where: { projectId, integrationId: keyId },
          select: { verification: true, verificationDetail: true },
        }).catch(() => null)
        const state = record?.verification ?? 'unchecked'
        if (state === 'verified') {
          satisfied.push(`${spec.description} API key confirmed by the provider`)
        } else if (state === 'rejected') {
          blocking.push(`${spec.description} API key was REJECTED by the provider — ${record?.verificationDetail ?? 'it is not a valid credential'}`)
        } else {
          satisfied.push(`${spec.description} API key stored — ${record?.verificationDetail ?? 'not confirmed with the provider'}`)
        }
      } else {
        satisfied.push(`${spec.description} API key stored`)
      }
    } else {
      if (keyId.includes('webhook_secret')) {
        blocking.push(
          `${spec.description} webhook secret is missing — required for HMAC signature verification on incoming events`,
        )
      } else if (keyId === integrationId) {
        blocking.push(`${spec.description} API key is not stored`)
      } else {
        blocking.push(`\`${keyId}\` key is missing`)
      }
    }
  }

  // 2. Required workspace tables — genuinely blocking ones only.
  for (const tableName of spec.requiredTables) {
    const table = await prisma.table.findFirst({
      where: { projectId, name: tableName },
      select: { id: true },
    })
    if (table) {
      satisfied.push(`\`${tableName}\` table exists`)
    } else {
      blocking.push(`\`${tableName}\` table is missing — run integration setup to create it`)
    }
  }

  // 2b. Suggested tables — reported, never blocking. A store that sells one-off
  // items must be able to reach "Complete" without a subscriptions table.
  const suggestions: string[] = []
  for (const s of spec.suggestedTables ?? []) {
    const table = await prisma.table.findFirst({
      where: { projectId, name: s.name },
      select: { id: true },
    })
    if (table) satisfied.push(`\`${s.name}\` table exists`)
    else suggestions.push(`\`${s.name}\` — optional. Adds ${s.unlocks}`)
  }

  // 3. Required generated routes/functions
  for (const pattern of spec.requiredFunctionPatterns) {
    const fn = await prisma.aiFunction.findFirst({
      where: { projectId, name: { contains: pattern } },
      select: { id: true, name: true },
    })
    if (fn) {
      satisfied.push(`\`${fn.name}\` endpoint/function generated`)
    } else {
      blocking.push(`\`${pattern}\` endpoint/function is not generated — store the integration key to auto-wire it`)
    }
  }

  // Determine overall status
  const primaryKeyPresent = await hasIntegrationKey(projectId, integrationId)
  let status: ReadinessStatus
  let label: string

  // OAuth integrations (google_auth, github_auth) require an external step (registering
  // callback URL) that Backenly cannot verify — mark as "Externally Pending" once key stored.
  const isOAuthIntegration = integrationId === 'google_auth' || integrationId === 'github_auth'

  if (!primaryKeyPresent) {
    status = 'key_stored' // nothing stored; effectively "not connected"
    label = 'Not Connected'
  } else if (blocking.length === 0) {
    status = 'behaviorally_ready'
    label = isOAuthIntegration ? 'Externally Pending' : 'Complete'
  } else if (satisfied.length > 0) {
    status = 'partially_configured'
    label = 'Partial'
  } else {
    status = 'key_stored'
    label = 'Blocked'
  }

  // Build next steps from blockers
  const nextSteps = blocking.map(b => `→ ${b}`)

  return {
    integrationId,
    status,
    label,
    blocking,
    satisfied,
    suggestions,
    nextSteps,
  }
}

/** Check all currently active integrations for a project. */
export async function checkAllIntegrationReadiness(
  projectId: string,
): Promise<IntegrationReadinessReport[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { activeIntegrations: true },
  })
  const active = (project?.activeIntegrations as Record<string, any>) ?? {}
  const ids = Object.keys(active).filter(k => active[k]?.enabled === true)
  if (ids.length === 0) return []
  return Promise.all(ids.map(id => checkIntegrationReadiness(projectId, id)))
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function readinessEmoji(status: ReadinessStatus): string {
  switch (status) {
    case 'behaviorally_ready':   return '✅'
    case 'partially_configured': return '⚠️'
    case 'key_stored':           return '🔑'
  }
}

/**
 * Produce a short chat-friendly summary for one readiness report.
 * Example:  "⚠️ Stripe — Partially Configured\n  → webhook secret is missing"
 */
export function formatReadinessReport(report: IntegrationReadinessReport): string {
  const lines: string[] = [
    `${readinessEmoji(report.status)} **${report.integrationId}** — ${report.label}`,
  ]
  if (report.satisfied.length > 0) {
    lines.push(...report.satisfied.map(s => `  ✓ ${s}`))
  }
  if (report.blocking.length > 0) {
    lines.push(...report.blocking.map(b => `  ✗ ${b}`))
  }
  // "○" not "✗" — these are choices, not defects. Rendering an optional table
  // with a failure marker is what made a plain storefront look misconfigured.
  if (report.suggestions.length > 0) {
    lines.push(...report.suggestions.map(s => `  ○ ${s}`))
  }
  return lines.join('\n')
}

/**
 * Compute the readiness status to persist in project.activeIntegrations.
 * Call this at the end of every executor after completing its setup work.
 */
export function toIntegrationRecord(
  report: IntegrationReadinessReport,
  extra: Record<string, any> = {},
): Record<string, any> {
  return {
    enabled: true,
    readiness: report.status,
    label: report.label,
    blocking: report.blocking,
    satisfiedCount: report.satisfied.length,
    activatedAt: extra.activatedAt ?? new Date().toISOString(),
    activatedBy: extra.activatedBy ?? 'integration_executor',
    ...extra,
  }
}
