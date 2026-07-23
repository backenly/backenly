/**
 * GOAL OVERRIDE PARSER
 * ====================
 * Parses user override signals embedded in a product goal message and applies
 * them to a ProductBlueprint before the build runtime executes.
 *
 * Supported overrides:
 *  - "No reviews"                    → remove entity
 *  - "Use PayPal instead of Stripe"  → swap integration
 *  - "Only email login"              → restrict auth providers to email
 *  - "Make it minimal"               → reduce scope (first 6 entities, no functions)
 *  - "No storage" / "no file uploads"→ remove all storage buckets
 *  - "No realtime"                   → remove all realtime channels
 *  - "No Stripe" / "no payments"     → remove payment integration
 *  - "No email" / "no notifications" → remove email integration
 *
 * Applied during goalUnderstandingStage after the blueprint is generated so
 * the build job reflects the user's intent exactly from the first compile.
 */

import type { ProductBlueprint } from './goal-understanding-engine'

// ── Override Directive ────────────────────────────────────────────────────────

export interface OverrideDirective {
  action:
    | 'remove_entity'
    | 'swap_integration'
    | 'restrict_auth'
    | 'reduce_scope'
    | 'remove_storage'
    | 'remove_integration'
    | 'remove_realtime'
  /** Primary target (entity name, integration name, or 'all') */
  target: string
  /** Replacement value for swap actions */
  replacement?: string
}

// ── Parser ────────────────────────────────────────────────────────────────────

const ENTITY_REMOVAL_WORDS = [
  'review', 'rating', 'comment', 'wishlist', 'cart', 'shipping',
  'subscription', 'notification', 'category', 'tag', 'analytic',
  'chat', 'forum', 'referral', 'coupon', 'voucher', 'discount',
  'favorite', 'bookmark', 'report', 'badge', 'achievement',
]

/**
 * Scan a user message for override signals.
 * Returns a (possibly empty) list of directives to apply.
 */
export function parseOverrides(message: string): OverrideDirective[] {
  const directives: OverrideDirective[] = []
  const seen = new Set<string>() // deduplicate

  const add = (d: OverrideDirective) => {
    const key = `${d.action}:${d.target}`
    if (!seen.has(key)) { seen.add(key); directives.push(d) }
  }

  // ── 1. Entity removal: "no reviews", "without cart", "skip analytics" ─────
  const removalRE = /\b(?:no|without|skip|remove|exclude|drop)\s+([\w\s]+?)(?:\s+(?:table|feature|module|section))?\b/gi
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = removalRE.exec(message)) !== null) {
    const candidate = m[1].trim().toLowerCase().replace(/s$/, '') // normalise plural → singular
    if (ENTITY_REMOVAL_WORDS.some(w => candidate.startsWith(w) || w.startsWith(candidate))) {
      add({ action: 'remove_entity', target: candidate })
    }
  }

  // ── 2. Integration swap: "use PayPal instead of Stripe" ───────────────────
  const swapRE = /\buse\s+(paypal|paddle|braintree|square|razorpay|lemon\s*squeez\w*)\s+(?:instead\s+of|not|rather\s+than|over|in\s+place\s+of)\s+(?:stripe|payments?)\b/gi
  // eslint-disable-next-line no-cond-assign
  while ((m = swapRE.exec(message)) !== null) {
    add({ action: 'swap_integration', target: 'stripe', replacement: m[1].toLowerCase().replace(/\s+/g, '') })
  }

  // ── 3. Auth restriction ───────────────────────────────────────────────────
  if (/\bonly\s+email\s+(?:login|auth(?:entication)?|sign[\s-]?in)\b/i.test(message)) {
    add({ action: 'restrict_auth', target: 'social' })
  }
  if (/\bno\s+(?:social|oauth|google|github|facebook|twitter)\s+(?:login|auth|sign[\s-]?in)\b/i.test(message)) {
    add({ action: 'restrict_auth', target: 'social' })
  }
  if (/\bno\s+(?:third.party|3rd.party)\s+(?:login|auth)\b/i.test(message)) {
    add({ action: 'restrict_auth', target: 'social' })
  }

  // ── 4. Scope reduction: "make it minimal / simple / basic" ────────────────
  if (/\b(?:make\s+it|keep\s+it|just\s+(?:a\s+)?|only\s+(?:a\s+)?)\s*(?:minimal|simple|basic|lean|lightweight|stripped?[\s-]?down)\b/i.test(message)) {
    add({ action: 'reduce_scope', target: 'all' })
  }
  if (/\bminimal\s+version\b/i.test(message)) {
    add({ action: 'reduce_scope', target: 'all' })
  }

  // ── 5. Storage removal ────────────────────────────────────────────────────
  if (/\b(?:no|skip|without)\s+(?:storage|file[\s-]?upload|uploads?|media\s+storage)\b/i.test(message)) {
    add({ action: 'remove_storage', target: 'all' })
  }

  // ── 6. Realtime removal ───────────────────────────────────────────────────
  if (/\b(?:no|skip|without)\s+(?:realtime|real[\s-]?time|live\s+updates?|websockets?|sockets?)\b/i.test(message)) {
    add({ action: 'remove_realtime', target: 'all' })
  }

  // ── 7. Specific integration removal ──────────────────────────────────────
  if (/\b(?:no|skip|without|remove|delete|disable)\s+(?:stripe|payments?|billing|checkout)\b/i.test(message)) {
    add({ action: 'remove_integration', target: 'stripe' })
  }
  if (/\b(?:no|skip|without|remove|delete|disable)\s+(?:email(?:\s+notification)?|resend|sendgrid|mailer|smtp)\b/i.test(message)) {
    add({ action: 'remove_integration', target: 'resend' })
  }
  if (/\b(?:no|skip|without|remove|delete|disable)\s+(?:openai|ai\s+function|llm)\b/i.test(message)) {
    add({ action: 'remove_integration', target: 'openai' })
  }

  return directives
}

// ── Applicator ────────────────────────────────────────────────────────────────

/**
 * Apply parsed override directives to a ProductBlueprint.
 * Returns a new blueprint (never mutates the original).
 */
export function applyOverridesToBlueprint(
  blueprint: ProductBlueprint,
  directives: OverrideDirective[],
): ProductBlueprint {
  if (directives.length === 0) return blueprint

  let bp = { ...blueprint }

  for (const dir of directives) {
    switch (dir.action) {
      case 'remove_entity': {
        // Match entity name loosely (singular, plural, partial)
        const t = dir.target.toLowerCase()
        bp = {
          ...bp,
          entities: bp.entities.filter(e => {
            const n = e.name.toLowerCase()
            return !n.startsWith(t) && !t.startsWith(n)
          }),
        }
        break
      }

      case 'swap_integration': {
        if (!dir.replacement) break
        bp = {
          ...bp,
          integrations: bp.integrations.map(i =>
            i.name.toLowerCase() === dir.target
              ? { ...i, name: dir.replacement!, credentialKey: dir.replacement!.toUpperCase() + '_SECRET_KEY' }
              : i,
          ),
        }
        break
      }

      case 'restrict_auth': {
        if (dir.target === 'social') {
          bp = {
            ...bp,
            authProviders: bp.authProviders.filter(p => p === 'email'),
          }
        }
        break
      }

      case 'reduce_scope': {
        // Keep users + up to 5 most-core domain entities; strip functions & realtime
        const usersEntity = bp.entities.find(e => e.name.toLowerCase() === 'users')
        const rest = bp.entities.filter(e => e.name.toLowerCase() !== 'users').slice(0, 5)
        bp = {
          ...bp,
          entities: usersEntity ? [usersEntity, ...rest] : rest,
          functions: [],
          realtimeChannels: [],
          storageBuckets: bp.storageBuckets.slice(0, 1), // keep at most one bucket
        }
        break
      }

      case 'remove_storage': {
        bp = { ...bp, storageBuckets: [] }
        break
      }

      case 'remove_realtime': {
        bp = { ...bp, realtimeChannels: [] }
        break
      }

      case 'remove_integration': {
        const t = dir.target.toLowerCase()
        bp = {
          ...bp,
          integrations: bp.integrations.filter(i => !i.name.toLowerCase().startsWith(t)),
        }
        break
      }
    }
  }

  console.log(
    `[GoalOverrideParser] Applied ${directives.length} override(s): ` +
    directives.map(d => `${d.action}(${d.target}${d.replacement ? '→' + d.replacement : ''})`).join(', '),
  )

  return bp
}
