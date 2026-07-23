/**
 * RESEARCH INTENT DETECTOR
 * ========================
 * Phase 11-14: Research-aware Plan mode
 *
 * Detects prompts that depend on external research:
 *   - Competitor references ("like Amazon", "check how Coupang works")
 *   - Market-style inference ("industry-standard", "how similar apps work")
 *   - "Build according to" competitor platforms
 *
 * Rules enforced:
 *   - Never pretend to browse external sites (Phase 14)
 *   - Force Plan mode for these prompts (Phase 11)
 *   - Map known platforms → structured domain assumptions (Phase 13)
 *   - Domain-specific forbidden defaults (Phase 12)
 */

// ─── Platform Knowledge Map ───────────────────────────────────────────────────

export interface PlatformKnowledge {
  /** Display name */
  name: string
  /** Detected domain type */
  domain: 'ecommerce' | 'marketplace' | 'saas' | 'booking' | 'social' | 'delivery' | 'fintech'
  /** Modules that are almost certainly included */
  coreModules: string[]
  /** Modules that are common but require confirmation */
  optionalModules: string[]
  /** Items that must NOT be assumed unless confirmed */
  forbiddenDefaults: string[]
  /** Questions that must be answered before building */
  requiredClarifications: string[]
}

const PLATFORM_MAP: Record<string, PlatformKnowledge> = {
  amazon: {
    name: 'Amazon',
    domain: 'ecommerce',
    coreModules: ['users/customers', 'product catalog', 'variants/SKUs', 'inventory', 'cart', 'checkout', 'one-time payments', 'shipping addresses', 'order tracking', 'admin'],
    optionalModules: ['reviews', 'wishlist', 'seller portal', 'recommendations', 'returns/refunds'],
    forbiddenDefaults: ['subscriptions', 'recurring billing', 'membership plans'],
    requiredClarifications: [
      'Single-seller store or marketplace (multiple sellers)?',
      'Physical goods, digital downloads, or both?',
      'Do you need seller payouts / commission splits?',
      'Do you need returns and refund management?',
    ],
  },
  coupang: {
    name: 'Coupang',
    domain: 'ecommerce',
    coreModules: ['users/customers', 'product catalog', 'variants/SKUs', 'inventory', 'cart', 'checkout', 'one-time payments', 'shipping addresses', 'order tracking', 'admin'],
    optionalModules: ['reviews', 'wishlist', 'seller portal', 'returns/refunds', 'express delivery tracking'],
    forbiddenDefaults: ['subscriptions', 'recurring billing', 'membership plans'],
    requiredClarifications: [
      'Single-seller store or marketplace?',
      'Do you need express/same-day delivery tracking?',
      'Physical goods or digital products?',
      'Do you need seller payouts?',
    ],
  },
  shopify: {
    name: 'Shopify',
    domain: 'ecommerce',
    coreModules: ['users/customers', 'product catalog', 'variants/SKUs', 'inventory', 'cart', 'checkout', 'one-time payments', 'shipping addresses', 'order tracking', 'admin', 'discount codes'],
    optionalModules: ['reviews', 'wishlists', 'abandoned cart', 'multi-currency', 'digital products'],
    forbiddenDefaults: ['subscriptions', 'recurring billing', 'marketplace seller payouts'],
    requiredClarifications: [
      'Single-seller or multi-vendor marketplace?',
      'Physical goods, digital downloads, or both?',
      'Do you need discount codes / promotions?',
      'Do you need multi-currency support?',
    ],
  },
  uber: {
    name: 'Uber',
    domain: 'marketplace',
    coreModules: ['riders', 'drivers', 'ride requests', 'real-time location', 'pricing', 'payments', 'ratings', 'trip history', 'admin'],
    optionalModules: ['surge pricing', 'scheduled rides', 'driver payouts', 'in-app chat'],
    forbiddenDefaults: ['product catalog', 'inventory', 'shipping'],
    requiredClarifications: [
      'Ride-hailing, food delivery, or a different service type?',
      'Do you need real-time driver tracking (WebSocket/SSE)?',
      'Do you need dynamic/surge pricing?',
      'Driver payouts — instant or weekly batch?',
    ],
  },
  airbnb: {
    name: 'Airbnb',
    domain: 'marketplace',
    coreModules: ['hosts', 'guests', 'listings', 'availability/calendar', 'bookings', 'payments', 'reviews', 'messaging', 'admin'],
    optionalModules: ['wishlists', 'instant booking', 'host payouts', 'guest verification'],
    forbiddenDefaults: ['inventory', 'shipping', 'cart', 'product catalog'],
    requiredClarifications: [
      'Properties only, or other rental types (cars, experiences)?',
      'Do you need instant booking or host-approval flow?',
      'Do you need host payouts (escrow + release on check-in)?',
      'Do you need guest ID verification?',
    ],
  },
  twitter: {
    name: 'Twitter / X',
    domain: 'social',
    coreModules: ['users', 'posts/tweets', 'follows', 'feed', 'likes', 'notifications', 'direct messages', 'media uploads'],
    optionalModules: ['retweets/reposts', 'hashtags/trending', 'bookmarks', 'lists', 'polls'],
    forbiddenDefaults: ['payments', 'subscriptions', 'product catalog'],
    requiredClarifications: [
      'Public feed or private/friend-only posts?',
      'Do you need real-time notifications (WebSocket/SSE)?',
      'Do you need media uploads (images/video)?',
      'Algorithmic feed ranking or chronological only?',
    ],
  },
  instagram: {
    name: 'Instagram',
    domain: 'social',
    coreModules: ['users', 'posts', 'follows', 'feed', 'likes', 'comments', 'stories', 'media uploads', 'notifications'],
    optionalModules: ['direct messages', 'explore/discover', 'hashtags', 'reels', 'shopping'],
    forbiddenDefaults: ['payments', 'subscriptions', 'product catalog'],
    requiredClarifications: [
      'Photos only, or also video/reels?',
      'Public or private/friend-only accounts?',
      'Do you need real-time direct messaging?',
      'Do you need a shopping/product tagging feature?',
    ],
  },
  stripe: {
    name: 'Stripe',
    domain: 'fintech',
    coreModules: ['users', 'payment methods', 'one-time charges', 'invoices', 'webhooks', 'audit logs'],
    optionalModules: ['subscriptions', 'metered billing', 'connect/payouts', 'disputes'],
    forbiddenDefaults: ['product catalog', 'inventory', 'shipping'],
    requiredClarifications: [
      'One-time payments, subscriptions, or both?',
      'Do you need marketplace payouts (Stripe Connect)?',
      'Do you need metered/usage-based billing?',
      'Do you need invoice generation?',
    ],
  },
}

// ─── Detection ────────────────────────────────────────────────────────────────

export interface ResearchIntentResult {
  /** True if this prompt needs research-aware Plan mode */
  isResearchIntent: boolean
  /** Platforms referenced in the prompt */
  referencedPlatforms: PlatformKnowledge[]
  /** Combined domain if unambiguous */
  detectedDomain: string | null
  /** The reason this was flagged */
  reason: string
}

/** Patterns that signal competitor/research-driven prompts */
const RESEARCH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bcheck how\s+\w+\s+(works?|is built|handles|manages)\b/i,          reason: 'Competitor research request' },
  { re: /\bresearch (similar|like|comparable) (apps?|platforms?|sites?)\b/i,  reason: 'Platform research request' },
  { re: /\b(like|similar to|inspired by|based on)\s+(amazon|coupang|shopify|uber|airbnb|twitter|instagram|stripe|alibaba|ebay|etsy|doordash|lyft|booking\.com|expedia|notion|slack|discord|reddit|tiktok)\b/i, reason: 'Named platform reference' },
  { re: /\bbuild (it |this )?(like|based on|according to|similar to|inspired by)\b/i, reason: 'Build-like-platform request' },
  { re: /\b(industry[- ]standard|standard ecommerce|typical ecommerce|standard marketplace|typical saas)\b.*backend/i, reason: 'Industry-standard pattern reference' },
  { re: /\bhow (amazon|coupang|shopify|uber|airbnb|twitter|instagram|stripe|alibaba|ebay) (works?|is built|handles|does it)\b/i, reason: 'How-platform-works question' },
  { re: /\b(check|look at|research|follow)\s+how\s+\w+\s+(does|handles|works?|builds?|manages?)\b/i, reason: 'Research instruction' },
  { re: /\baccording to (those|these|similar|competitor|that) (platform|app|site|company)\b/i, reason: 'Build-according-to-platform' },
]

const PLATFORM_NAME_RE = /\b(amazon|coupang|shopify|uber|airbnb|twitter|instagram|stripe|alibaba|ebay|etsy|doordash|lyft)\b/gi

export function detectResearchIntent(message: string): ResearchIntentResult {
  const lower = message.toLowerCase()

  let reason = ''
  for (const { re, reason: r } of RESEARCH_PATTERNS) {
    if (re.test(lower)) { reason = r; break }
  }

  const platformMatches = (message.match(PLATFORM_NAME_RE) ?? [])
    .map(p => p.toLowerCase())
    .filter((p, i, arr) => arr.indexOf(p) === i) // dedupe

  const referencedPlatforms = platformMatches
    .map(p => PLATFORM_MAP[p])
    .filter((p): p is PlatformKnowledge => !!p)

  // Don't flag as research when the user wants to *use* a platform (connect/add/integrate/enable).
  // A bare platform mention in an execution context (e.g. "Connect Stripe checkout") is NOT research.
  const EXECUTION_INTENT_RE =
    /\b(connect|add|integrate|implement|use|enable|setup|set up|configure|build with|include|plug in|wire up)\s+/i
  const platformMentionIsExecution =
    referencedPlatforms.length > 0 && EXECUTION_INTENT_RE.test(message) && reason === ''

  const isResearchIntent = reason !== '' || (referencedPlatforms.length > 0 && !platformMentionIsExecution)

  // Determine combined domain
  const domains = [...new Set(referencedPlatforms.map(p => p.domain))]
  const detectedDomain = domains.length === 1 ? domains[0] : null

  return { isResearchIntent, referencedPlatforms, detectedDomain, reason: reason || (isResearchIntent ? 'Named platform referenced' : '') }
}

// ─── Domain Forbidden Defaults (Phase 12) ────────────────────────────────────

/**
 * Per-domain items that must NEVER be auto-assumed.
 * Used by the plan response generator to explicitly call them out.
 */
export const DOMAIN_FORBIDDEN_DEFAULTS: Record<string, string[]> = {
  ecommerce:   ['subscriptions', 'recurring billing', 'membership plans', 'marketplace seller payouts'],
  marketplace: ['product inventory', 'shipping labels', 'subscription plans'],
  saas:        ['marketplace features', 'physical shipping', 'driver routing'],
  booking:     ['inventory management', 'product catalog', 'recurring subscriptions'],
  social:      ['payments', 'product catalog', 'inventory', 'shipping'],
  delivery:    ['subscription plans', 'product catalog without catalog flag'],
  fintech:     ['product catalog', 'physical inventory', 'shipping'],
}

// ─── Plan Response Builder (Phase 11 + 13 + 14) ──────────────────────────────

export interface ResearchPlanResponse {
  message: string
  proposed_architecture: string | null
  required_steps: string[] | null
  missing_inputs: string[] | null
}

export function buildResearchPlanResponse(
  message: string,
  result: ResearchIntentResult,
): ResearchPlanResponse {
  const hasPlatforms = result.referencedPlatforms.length > 0
  const platform = result.referencedPlatforms[0] // primary reference

  // Phase 14: Honest browsing disclaimer
  const browsingDisclaimer = `I'm not browsing those sites live. I'll design the backend based on well-known architecture patterns for this type of platform.`

  // Phase 13: Build assumption summary from platform knowledge
  let architectureSummary: string | null = null
  let requiredSteps: string[] | null = null
  const clarifications: string[] = []

  if (hasPlatforms) {
    // Merge core modules from all referenced platforms (deduplicated)
    const allCore = [...new Set(result.referencedPlatforms.flatMap(p => p.coreModules))]
    const allOptional = [...new Set(result.referencedPlatforms.flatMap(p => p.optionalModules))]
    const allForbidden = [...new Set(result.referencedPlatforms.flatMap(p => p.forbiddenDefaults))]
    const allClarifications = [...new Set(result.referencedPlatforms.flatMap(p => p.requiredClarifications))]

    const platformNames = result.referencedPlatforms.map(p => p.name).join(' / ')

    architectureSummary = [
      `**Detected reference:** ${platformNames}-style platform`,
      ``,
      `**Likely backend modules:**`,
      allCore.map(m => `- ${m}`).join('\n'),
      ``,
      `**Optional modules (confirm to include):**`,
      allOptional.map(m => `- ${m}`).join('\n'),
      ``,
      `**Will NOT be added unless you explicitly request:**`,
      allForbidden.map(m => `- ${m}`).join('\n'),
    ].join('\n')

    requiredSteps = allCore.map(m => `Create backend support for: ${m}`)

    clarifications.push(...allClarifications)
  } else if (result.detectedDomain) {
    // Generic domain without specific platform
    const forbidden = DOMAIN_FORBIDDEN_DEFAULTS[result.detectedDomain] ?? []
    architectureSummary = `**Detected domain:** ${result.detectedDomain}\n\nI'll use standard ${result.detectedDomain} backend patterns.`
    if (forbidden.length > 0) {
      architectureSummary += `\n\n**Will NOT be added by default:** ${forbidden.join(', ')}`
    }
  }

  // Build the message
  const parts: string[] = []

  if (hasPlatforms) {
    parts.push(browsingDisclaimer)
    parts.push('')
  }

  if (architectureSummary) {
    parts.push(architectureSummary)
  }

  if (clarifications.length > 0) {
    parts.push(`\n**Before I build, please confirm:**`)
    clarifications.forEach((q, i) => parts.push(`${i + 1}. ${q}`))
  }

  parts.push(`\nAnswer the questions above and I'll build the exact backend you need.`)

  const missing = clarifications.length > 0 ? clarifications : ['Platform type not confirmed']

  return {
    message: parts.join('\n'),
    proposed_architecture: architectureSummary,
    required_steps: requiredSteps,
    missing_inputs: missing,
  }
}
