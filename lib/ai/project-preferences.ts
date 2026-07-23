/**
 * PROJECT PREFERENCES — Runtime Memory
 * ======================================
 * Learns and persists per-project user preferences across builds.
 * Stored in `ProjectPreference` Prisma model (@@unique on projectId+type+key).
 *
 * Preference categories:
 *  - auth_provider   : 'clerk', 'supabase', 'jwt' — preferred auth system
 *  - payment         : 'stripe', 'paypal', 'paddle' — preferred payment provider
 *  - email           : 'resend', 'sendgrid', 'smtp' — preferred email provider
 *  - excluded_entity : entity names the user previously excluded
 *  - style           : 'minimal', 'full' — build scope preference
 *  - realtime_off    : user prefers no realtime by default
 *
 * Confidence system: each preference has positiveSignals / negativeSignals.
 * Only preferences with confidence >= 0.5 are applied automatically.
 * Applying a preference adds a positive signal; an override removes it.
 */

import type { ProductBlueprint, BlueprintIntegration } from '@/lib/ai/goal-understanding-engine'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserPreference {
  type: string
  key: string
  value: string
  confidence: number
  positiveSignals: number
  negativeSignals: number
}

// ── Preference detection patterns ─────────────────────────────────────────────

const AUTH_PROVIDER_PATTERNS: Array<[RegExp, string]> = [
  [/\bclerk\b/i, 'clerk'],
  [/\bsupabase\s*auth\b/i, 'supabase'],
  [/\bnext.?auth\b/i, 'nextauth'],
  [/\bjwt\b/i, 'jwt'],
  [/\bauth0\b/i, 'auth0'],
]

const PAYMENT_PATTERNS: Array<[RegExp, string]> = [
  [/\bstripe\b/i, 'stripe'],
  [/\bpaypal\b/i, 'paypal'],
  [/\bpaddle\b/i, 'paddle'],
  [/\brazorpay\b/i, 'razorpay'],
  [/\blemonsqueezy\b/i, 'lemonsqueezy'],
]

const EMAIL_PATTERNS: Array<[RegExp, string]> = [
  [/\bresend\b/i, 'resend'],
  [/\bsendgrid\b/i, 'sendgrid'],
  [/\bmailgun\b/i, 'mailgun'],
  [/\bpostmark\b/i, 'postmark'],
]

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load stored preferences for a project.
 * Only returns preferences with confidence >= 0.5 (enough positive signal).
 */
export async function loadUserPreferences(projectId: string): Promise<UserPreference[]> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const rows = await prisma.projectPreference.findMany({
      where: {
        projectId,
        confidence: { gte: 0.5 },
      },
      orderBy: { confidence: 'desc' },
    })
    return rows.map(r => ({
      type: r.type,
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      positiveSignals: r.positiveSignals,
      negativeSignals: r.negativeSignals,
    }))
  } catch {
    return []
  }
}

/**
 * Apply stored preferences to a blueprint before execution.
 *
 * Rules applied:
 *  - auth_provider: override blueprint.authProviders
 *  - payment: replace Stripe with preferred provider in integrations
 *  - email: replace Resend with preferred email provider
 *  - excluded_entity: remove entity from blueprint.entities
 *  - style=minimal: trim to 6 entities, remove functions/realtime
 *  - realtime_off: clear realtimeChannels
 */
export function applyPreferencesToBlueprint(
  blueprint: ProductBlueprint,
  prefs: UserPreference[],
): ProductBlueprint {
  let bp = { ...blueprint }

  for (const pref of prefs) {
    switch (pref.type) {
      case 'auth_provider': {
        if (pref.key === 'provider') {
          bp = { ...bp, authProviders: [pref.value] }
        }
        break
      }

      case 'payment': {
        if (pref.key === 'provider' && pref.value !== 'stripe') {
          // Swap Stripe for preferred provider
          bp = {
            ...bp,
            integrations: bp.integrations.map((i): BlueprintIntegration =>
              i.name.toLowerCase() === 'stripe'
                ? { ...i, name: pref.value, credentialKey: pref.value.toUpperCase() + '_SECRET_KEY' }
                : i
            ),
          }
        }
        break
      }

      case 'email': {
        if (pref.key === 'provider' && pref.value !== 'resend') {
          bp = {
            ...bp,
            integrations: bp.integrations.map((i): BlueprintIntegration =>
              i.name.toLowerCase() === 'resend'
                ? { ...i, name: pref.value, credentialKey: pref.value.toUpperCase() + '_API_KEY' }
                : i
            ),
          }
        }
        break
      }

      case 'excluded_entity': {
        const excluded = pref.value.toLowerCase()
        bp = {
          ...bp,
          entities: bp.entities.filter(e => !e.name.toLowerCase().startsWith(excluded)),
        }
        break
      }

      case 'style': {
        if (pref.key === 'scope' && pref.value === 'minimal') {
          const usersEntity = bp.entities.find(e => e.name.toLowerCase() === 'users')
          const rest = bp.entities.filter(e => e.name.toLowerCase() !== 'users').slice(0, 5)
          bp = {
            ...bp,
            entities: usersEntity ? [usersEntity, ...rest] : rest.slice(0, 6),
            functions: [],
          }
        }
        break
      }

      case 'realtime': {
        if (pref.key === 'enabled' && pref.value === 'false') {
          bp = { ...bp, realtimeChannels: [] }
        }
        break
      }
    }
  }

  return bp
}

/**
 * Scan a message + blueprint for new preference signals and persist them.
 * Fire-and-forget — never blocks the build pipeline.
 */
export async function detectAndSavePreferences(
  projectId: string,
  message: string,
  blueprint: ProductBlueprint,
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const prefs: Array<{ type: string; key: string; value: string }> = []

    // Auth provider
    for (const [re, provider] of AUTH_PROVIDER_PATTERNS) {
      if (re.test(message)) {
        prefs.push({ type: 'auth_provider', key: 'provider', value: provider })
        break
      }
    }

    // Payment provider
    for (const [re, provider] of PAYMENT_PATTERNS) {
      if (re.test(message)) {
        prefs.push({ type: 'payment', key: 'provider', value: provider })
        break
      }
    }

    // Email provider
    for (const [re, provider] of EMAIL_PATTERNS) {
      if (re.test(message)) {
        prefs.push({ type: 'email', key: 'provider', value: provider })
        break
      }
    }

    // Minimal style signal
    if (/\b(minimal|simple|basic|lean|lightweight)\b/i.test(message)) {
      prefs.push({ type: 'style', key: 'scope', value: 'minimal' })
    }

    // Realtime off
    if (/\bno\s+(?:realtime|real[\s-]?time|live\s+updates?)\b/i.test(message)) {
      prefs.push({ type: 'realtime', key: 'enabled', value: 'false' })
    }

    // Explicit entity exclusions become persistent preferences
    const noPatterns = message.match(/\bno\s+(reviews?|ratings?|comments?|wishlists?|carts?)\b/gi) ?? []
    for (const match of noPatterns) {
      const entity = match.replace(/^no\s+/i, '').toLowerCase().replace(/s$/, '')
      prefs.push({ type: 'excluded_entity', key: 'name', value: entity })
    }

    // Upsert each preference (increment positive signals)
    for (const pref of prefs) {
      const existing = await prisma.projectPreference.findUnique({
        where: { projectId_type_key: { projectId, type: pref.type, key: pref.key } },
      })

      if (existing) {
        // Only update if same value — if different, the user is changing preference
        const positiveSignals = existing.value === pref.value
          ? existing.positiveSignals + 1
          : 1
        const negativeSignals = existing.value !== pref.value
          ? existing.negativeSignals + 1
          : existing.negativeSignals
        const confidence = Math.min(
          positiveSignals / (positiveSignals + negativeSignals + 1),
          0.95,
        )
        await prisma.projectPreference.update({
          where: { id: existing.id },
          data: {
            value: pref.value,  // update to latest signal
            positiveSignals,
            negativeSignals,
            confidence,
            lastSeen: new Date(),
          },
        })
      } else {
        await prisma.projectPreference.create({
          data: {
            projectId,
            type: pref.type,
            key: pref.key,
            value: pref.value,
            confidence: 0.3,  // start low — needs reinforcement
            positiveSignals: 1,
            negativeSignals: 0,
          },
        })
      }
    }

    if (prefs.length > 0) {
      console.log(`[ProjectPreferences] Saved ${prefs.length} preference(s) for project ${projectId}`)
    }
  } catch (err) {
    console.warn('[ProjectPreferences] Failed to save preferences (non-fatal):', err)
  }
}

/**
 * Explicitly record a user's integration choice after a build.
 * Called from run-build.ts when integrations are confirmed active.
 */
export async function recordIntegrationPreference(
  projectId: string,
  category: 'payment' | 'email' | 'ai',
  provider: string,
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    await prisma.projectPreference.upsert({
      where: { projectId_type_key: { projectId, type: category, key: 'provider' } },
      create: {
        projectId,
        type: category,
        key: 'provider',
        value: provider,
        confidence: 0.7,
        positiveSignals: 2,
        negativeSignals: 0,
      },
      update: {
        value: provider,
        positiveSignals: { increment: 1 },
        confidence: 0.8,
        lastSeen: new Date(),
      },
    })
  } catch {
    // Non-fatal
  }
}
