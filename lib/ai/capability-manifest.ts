/**
 * CAPABILITY MANIFEST — Issue 21
 * ================================
 * Single authoritative source of what the AI can and cannot automate.
 *
 * Rules:
 *   - The AI must NEVER claim automation is happening when it is not.
 *   - When a feature is not automatable, it MUST emit [CANNOT DO AUTOMATICALLY].
 *   - This manifest is code — the LLM cannot override it with confident prose.
 *   - Every capability entry has: automatable, reason (if not), manualPath, and an
 *     optional fallback the AI CAN offer instead.
 */

/**
 * Automation tier for a capability:
 *   full    — Backenly automates everything. No manual steps needed.
 *   partial — Backenly automates the infrastructure but needs one credential/input from the developer.
 *             The AI proceeds with what it can, then surfaces exactly what's needed.
 *   guided  — Backenly cannot automate it but gives a precise step-by-step guide.
 *             No execution happens; the AI acts as an expert advisor.
 *   none    — Completely out of scope. Backenly explains why and offers the best alternative.
 */
export type AutomationTier = 'full' | 'partial' | 'guided' | 'none'

export interface CapabilityEntry {
  /** Whether Backenly can perform this automatically right now */
  automatable: boolean
  /** Explicit automation tier (more nuanced than the boolean) */
  automationTier: AutomationTier
  /** What Backenly CAN do in this category (even if partial) */
  whatItCanDo: string
  /** Reason it is NOT fully automatable (only when automatable = false) */
  blockedReason?: string
  /** Exact manual steps the user must follow (only when automatable = false) */
  manualPath?: string
  /** Fallback Backenly will offer when it cannot fully automate */
  fallback?: string
  /**
   * For 'partial' tier: the specific input the developer must provide to unlock full automation.
   * e.g. "Paste your Stripe secret key (sk_live_... or sk_test_...)"
   */
  neededFromDeveloper?: string
}

export const CAPABILITY_MANIFEST: Record<string, CapabilityEntry> = {
  // ── Database ─────────────────────────────────────────────────────────────────
  create_table: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Create tables with columns, FK relations, indexes, and RLS policies in the workspace schema',
  },
  alter_table: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Add columns, rename columns, add constraints to existing tables',
  },
  drop_table: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Drop a table and all its data — requires two-step confirmation in chat before executing',
  },
  generate_api: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Generate REST CRUD endpoints (GET, POST, PUT, DELETE) for any table',
  },

  // ── Auth ─────────────────────────────────────────────────────────────────────
  enable_jwt_auth: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Enable email/password auth with JWT, create users table, generate auth endpoints',
  },
  enable_oauth_google: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Register Google as an OAuth provider, configure callback URL, create auth endpoints',
    blockedReason: 'Google OAuth requires a Client ID and Client Secret from the Google Cloud Console — these cannot be generated automatically',
    manualPath: 'Go to console.cloud.google.com → APIs & Services → Credentials → Create OAuth 2.0 Client ID. Then enter credentials via Settings → Auth → Google OAuth or paste them in chat.',
    fallback: 'I can register the Google OAuth provider and configure the callback URL. Once you paste your credentials, I will activate it automatically.',
    neededFromDeveloper: 'Paste your Google OAuth Client ID and Client Secret from console.cloud.google.com',
  },
  enable_oauth_github: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Register GitHub as an OAuth provider, configure callback URL, create auth endpoints',
    blockedReason: 'GitHub OAuth requires a Client ID and Client Secret from a GitHub OAuth App — these cannot be generated automatically',
    manualPath: 'Go to github.com/settings/applications/new → create an OAuth App. Then paste your Client ID and Client Secret in chat.',
    fallback: 'I can register the GitHub OAuth provider and configure the callback URL. Once you paste your credentials, I will activate it automatically.',
    neededFromDeveloper: 'Paste your GitHub OAuth Client ID and Client Secret from github.com/settings/applications',
  },
  enable_oauth_facebook: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Register Facebook as an OAuth provider',
    blockedReason: 'Facebook OAuth requires an App ID and App Secret from the Facebook Developer Console',
    manualPath: 'Go to developers.facebook.com → create an app → get App ID and App Secret. Then paste them in chat.',
    fallback: 'I can register the Facebook OAuth provider. Once you paste your credentials, I will activate it.',
    neededFromDeveloper: 'Paste your Facebook App ID and App Secret from developers.facebook.com',
  },
  enable_oauth_apple: {
    automatable: false,
    automationTier: 'guided',
    whatItCanDo: 'Register Apple Sign In as an OAuth provider',
    blockedReason: 'Apple Sign In requires a Services ID, Team ID, Key ID, and private key (.p8 file) from the Apple Developer portal — these cannot be generated automatically',
    manualPath: 'Go to developer.apple.com → Certificates, Identifiers & Profiles → Services IDs. Then enter all credentials via Settings → Auth → Apple.',
    fallback: 'I can register Apple as a provider and prepare the auth endpoints. The credentials must be entered manually.',
    neededFromDeveloper: 'Services ID, Team ID, Key ID, and .p8 private key from developer.apple.com',
  },

  // ── Storage ──────────────────────────────────────────────────────────────────
  create_storage_bucket: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Create storage buckets with public/private access, MIME type restrictions, and size limits',
  },
  delete_storage_file: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Delete files from a storage bucket via the AI function or API endpoint',
  },

  // ── Payments ─────────────────────────────────────────────────────────────────
  setup_stripe_schema: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Create orders, payment_events tables and generate Stripe-ready REST APIs',
  },
  activate_stripe_payments: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Create payment schema and webhook endpoint structure',
    blockedReason: 'Stripe requires a secret key (sk_live_... or sk_test_...) and a webhook signing secret — these must come from your Stripe dashboard',
    manualPath: 'Go to dashboard.stripe.com/apikeys → copy your secret key. Then paste it in chat to connect automatically.',
    fallback: 'I can create the orders table, payment_events table, and REST API. Once you paste your Stripe secret key, I will activate the payment flow.',
    neededFromDeveloper: 'Paste your Stripe secret key (sk_live_... or sk_test_...) from dashboard.stripe.com/apikeys',
  },

  // ── Email ────────────────────────────────────────────────────────────────────
  setup_email_schema: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Create email_logs table and generate email-ready API endpoint',
  },
  activate_resend: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Create email schema and generate email trigger templates',
    blockedReason: 'Resend requires an API key (re_...) — this must come from your Resend dashboard',
    manualPath: 'Go to resend.com/api-keys → create a key. Then paste it in chat to connect automatically.',
    fallback: 'I can create the email_logs table. Once you paste your Resend API key, I will activate email sending.',
    neededFromDeveloper: 'Paste your Resend API key (re_...) from resend.com/api-keys',
  },
  activate_sendgrid: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Create email schema and generate email trigger templates',
    blockedReason: 'SendGrid requires an API key (SG...) — this must come from your SendGrid dashboard',
    manualPath: 'Go to app.sendgrid.com/settings/api_keys → create a key. Then paste it in chat to connect automatically.',
    fallback: 'I can create the email_logs table. Once you paste your SendGrid API key, I will activate email sending.',
    neededFromDeveloper: 'Paste your SendGrid API key (SG...) from app.sendgrid.com/settings/api_keys',
  },

  // ── Video Generation Providers ───────────────────────────────────────────────
  activate_runway: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Create generation_jobs table, job processor endpoint, status polling endpoint, and output storage bucket',
    blockedReason: 'Runway ML requires an API key — go to app.runwayml.com → Settings → API Keys and paste it in chat.',
    manualPath: 'app.runwayml.com → Settings → API Keys → Create new key. Then paste it in chat.',
    fallback: 'I can create the generation_jobs table with all 17 columns, the job processor, and storage buckets. Once you paste your Runway API key, I will activate the video generation pipeline.',
    neededFromDeveloper: 'Paste your Runway ML API key from app.runwayml.com/account/api-keys',
  },
  activate_stability: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Create generation_jobs table, Stability AI image/video generation endpoint, and output storage bucket',
    blockedReason: 'Stability AI requires an API key — go to platform.stability.ai/account/keys and paste it in chat.',
    manualPath: 'platform.stability.ai/account/keys → Create API Key. Then paste it in chat.',
    fallback: 'I can create the generation_jobs table and image generation endpoints. Once you paste your Stability AI key, I will activate generation.',
    neededFromDeveloper: 'Paste your Stability AI API key from platform.stability.ai/account/keys',
  },
  activate_kling: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Create generation_jobs table, Kling video generation endpoint via Replicate, and output storage bucket',
    blockedReason: 'Kling runs on Replicate — get your Replicate API token at replicate.com/account/api-tokens and paste it in chat.',
    manualPath: 'replicate.com/account/api-tokens → Create token. Then paste it in chat (starts with r8_...).',
    fallback: 'I can create the generation_jobs table and Kling endpoint code. Once you paste your Replicate token, I will activate it.',
    neededFromDeveloper: 'Paste your Replicate API token (r8_...) from replicate.com/account/api-tokens',
  },
  activate_pika: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Create generation_jobs table, Pika video generation endpoint, and output storage bucket',
    blockedReason: 'Pika Labs requires an API key from their developer program.',
    manualPath: 'pika.art/developers → request API access → paste your key in chat.',
    fallback: 'I can create the generation_jobs table and endpoint structure. Once you have a Pika API key, I will activate it.',
    neededFromDeveloper: 'Paste your Pika Labs API key (from pika.art/developers)',
  },
  activate_replicate: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Create generation_jobs table, Replicate model endpoint, and output storage bucket',
    blockedReason: 'Replicate requires an API token — go to replicate.com/account/api-tokens.',
    manualPath: 'replicate.com/account/api-tokens → Create token. Then paste it in chat (starts with r8_...).',
    fallback: 'I can create the generation table and endpoint scaffold. Once you paste your Replicate token (r8_...), I will activate it.',
    neededFromDeveloper: 'Paste your Replicate API token (r8_...) from replicate.com/account/api-tokens',
  },

  // ── Background Jobs / Queues ──────────────────────────────────────────────────
  activate_redis: {
    automatable: false,
    automationTier: 'partial',
    whatItCanDo: 'Configure job queue with Redis-backed BullMQ for async processing',
    blockedReason: 'Redis requires a connection URL — provide REDIS_URL to activate BullMQ job queues.',
    manualPath: 'Upstash (upstash.com) or Redis Cloud → create a database → copy the Redis URL → add REDIS_URL to your environment variables.',
    fallback: 'I can generate the job processing code with an in-memory fallback. For production, add REDIS_URL and I will switch to BullMQ.',
    neededFromDeveloper: 'Add REDIS_URL to your environment variables (get one from upstash.com — free tier available)',
  },

  // ── Realtime ─────────────────────────────────────────────────────────────────
  enable_realtime: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Enable real-time subscriptions on any table (INSERT/UPDATE/DELETE events via SSE)',
  },
  create_trigger: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Create event triggers that fire on INSERT/UPDATE/DELETE operations',
  },

  // ── Functions ────────────────────────────────────────────────────────────────
  create_ai_function: {
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Create serverless AI functions described in natural language (compute, transform, validate logic)',
  },

  // ── Infrastructure ────────────────────────────────────────────────────────────
  custom_domain: {
    automatable: false,
    automationTier: 'none',
    whatItCanDo: 'Nothing — domain configuration is handled by your hosting provider',
    blockedReason: 'Custom domain configuration requires DNS access and is not managed by Backenly',
    manualPath: 'Add a CNAME record in your DNS provider pointing to your Backenly deployment URL',
    fallback: 'I can deploy your backend and give you the Backenly URL. Custom domain setup is done in your DNS provider.',
  },
  raw_sql: {
    // Reads are automatable and supported; only writes are blocked.
    automatable: true,
    automationTier: 'full',
    whatItCanDo: 'Run read-only SQL with run_query (joins, aggregates, window functions, CTEs, EXPLAIN), and translate change requests into structured backend operations (tables, APIs, functions)',
    blockedReason: 'SQL writes and DDL are not executed directly — they bypass multi-tenant safety, RLS policies, and schema versioning, and cannot be reversed',
    manualPath: 'Query freely with run_query; to CHANGE anything, describe it and I will build it through typed, reversible operations',
    fallback: 'For reads, ask me the question and I will run the SQL. For changes, tell me what you need and I will create the right tables and APIs.',
  },
}

// ── Capability checker ────────────────────────────────────────────────────────

/**
 * Look up whether a feature is automatable.
 * Returns the full entry with automatable, reason, and manualPath.
 */
export function checkCapability(featureKey: string): CapabilityEntry | null {
  return CAPABILITY_MANIFEST[featureKey] ?? null
}

/**
 * Detect if a message is requesting something outside the capability manifest.
 * Returns a matched entry if the message clearly requests a non-automatable feature.
 */
export function detectNonAutomatableRequest(message: string): {
  featureKey: string
  entry: CapabilityEntry
} | null {
  const lower = message.toLowerCase()

  // OAuth provider detection
  if (/\b(add|enable|setup|integrate)\b.{0,30}\bgoogle\b.{0,20}\b(auth|oauth|login|sign.?in)\b/i.test(lower)) {
    const entry = CAPABILITY_MANIFEST.enable_oauth_google
    if (!entry.automatable) return { featureKey: 'enable_oauth_google', entry }
  }
  if (/\b(add|enable|setup|integrate)\b.{0,30}\bgithub\b.{0,20}\b(auth|oauth|login|sign.?in)\b/i.test(lower)) {
    const entry = CAPABILITY_MANIFEST.enable_oauth_github
    if (!entry.automatable) return { featureKey: 'enable_oauth_github', entry }
  }
  if (/\b(add|enable|setup|integrate)\b.{0,30}\bfacebook\b.{0,20}\b(auth|oauth|login|sign.?in)\b/i.test(lower)) {
    const entry = CAPABILITY_MANIFEST.enable_oauth_facebook
    if (!entry.automatable) return { featureKey: 'enable_oauth_facebook', entry }
  }
  if (/\b(add|enable|setup|integrate)\b.{0,30}\bapple\b.{0,20}\b(auth|oauth|login|sign.?in|sign in with apple)\b/i.test(lower)) {
    const entry = CAPABILITY_MANIFEST.enable_oauth_apple
    if (!entry.automatable) return { featureKey: 'enable_oauth_apple', entry }
  }

  // Video generation providers
  if (/\brunway\b.{0,30}\b(ml|ai|generate|video|gen)\b|\b(video|gen).{0,30}\brunway\b/i.test(lower)) {
    const entry = CAPABILITY_MANIFEST.activate_runway
    if (!entry.automatable) return { featureKey: 'activate_runway', entry }
  }
  if (/\bstability[\s-]?ai\b|\bstable[\s-]?diffusion\b|\bsdxl\b/i.test(lower)) {
    const entry = CAPABILITY_MANIFEST.activate_stability
    if (!entry.automatable) return { featureKey: 'activate_stability', entry }
  }
  if (/\bkling\b.{0,20}\b(video|gen|ai)\b|\b(video|gen).{0,20}\bkling\b/i.test(lower)) {
    const entry = CAPABILITY_MANIFEST.activate_kling
    if (!entry.automatable) return { featureKey: 'activate_kling', entry }
  }
  if (/\bpika\b.{0,20}\b(labs|video|gen|ai)\b/i.test(lower)) {
    const entry = CAPABILITY_MANIFEST.activate_pika
    if (!entry.automatable) return { featureKey: 'activate_pika', entry }
  }
  if (/\breplicate\b.{0,30}\b(model|run|api|generate)\b/i.test(lower)) {
    const entry = CAPABILITY_MANIFEST.activate_replicate
    if (!entry.automatable) return { featureKey: 'activate_replicate', entry }
  }

  // Infrastructure
  if (/\bcustom[\s-]?domain\b/i.test(lower)) {
    return { featureKey: 'custom_domain', entry: CAPABILITY_MANIFEST.custom_domain }
  }
  if (/\braw[\s-]?sql\b|\bexecute[\s-]?sql\b|\brun[\s-]?sql\b|\bwrite[\s-]?sql\b/i.test(lower)) {
    return { featureKey: 'raw_sql', entry: CAPABILITY_MANIFEST.raw_sql }
  }

  return null
}

// ── Domain-aware integration recommendations ──────────────────────────────────

/**
 * Given the set of tables already in a project, return integrations the user
 * should be prompted to configure — because the tables clearly need them.
 *
 * This replaces keyword-only detection (#87): the decision is based on what
 * the project has BUILT, not what the user typed.
 */
export interface IntegrationRecommendation {
  integrationId: string
  reason: string
  urgency: 'required' | 'recommended'
  promptHint: string
}

const DOMAIN_INTEGRATION_RULES: Array<{
  tablePatterns: RegExp[]
  integrationId: string
  reason: string
  urgency: 'required' | 'recommended'
  promptHint: string
}> = [
  // Video/AI generation tables → video generation provider required
  {
    tablePatterns: [/generation_jobs?/, /render_jobs?/, /video_jobs?/, /ai_jobs?/, /clip_jobs?/],
    integrationId: 'activate_runway',
    reason: 'Your project has a generation_jobs table but no video generation provider is configured',
    urgency: 'required',
    promptHint: 'Paste your Runway ML API key (`key_...`) or Replicate token (`r8_...`) to activate video generation.',
  },
  // Notifications or email_logs table → email provider required
  {
    tablePatterns: [/^notifications?$/, /email_logs?/, /^emails?$/, /^messages?$/],
    integrationId: 'activate_resend',
    reason: 'Your project has a notifications/email table but no email provider is configured',
    urgency: 'required',
    promptHint: 'Paste your Resend API key (`re_...`) or SendGrid key (`SG...`) to activate email sending.',
  },
  // Invoices or subscriptions → Stripe required
  {
    tablePatterns: [/^invoices?$/, /^subscriptions?$/, /^payments?$/, /^orders?$/],
    integrationId: 'activate_stripe_payments',
    reason: 'Your project has billing tables but no Stripe key is configured',
    urgency: 'required',
    promptHint: 'Paste your Stripe secret key (`sk_live_...` or `sk_test_...`) to activate payment processing.',
  },
  // Large async job tables → Redis recommended
  {
    tablePatterns: [/jobs?$/, /queue/, /tasks?$/, /pipeline/],
    integrationId: 'activate_redis',
    reason: 'Your project has async job tables — Redis queues are recommended for reliable job processing',
    urgency: 'recommended',
    promptHint: 'Add REDIS_URL (from Upstash or Redis Cloud) to upgrade from in-memory to production-grade job queues.',
  },
]

export function getIntegrationRecommendations(
  projectTables: string[],
  configuredIntegrations: string[],
): IntegrationRecommendation[] {
  const recs: IntegrationRecommendation[] = []
  const tableNames = projectTables.map(t => t.toLowerCase())

  for (const rule of DOMAIN_INTEGRATION_RULES) {
    // Skip if already configured
    if (configuredIntegrations.includes(rule.integrationId)) continue

    // Check if any project table matches any of the rule's patterns
    const triggered = rule.tablePatterns.some(pat =>
      tableNames.some(t => pat.test(t))
    )
    if (!triggered) continue

    recs.push({
      integrationId: rule.integrationId,
      reason: rule.reason,
      urgency: rule.urgency,
      promptHint: rule.promptHint,
    })
  }

  return recs
}

// ── Response formatters ───────────────────────────────────────────────────────

/**
 * Format the canonical capability boundary message.
 * Tier-aware: partial shows what IS automated + what's needed.
 *             guided shows a step-by-step guide.
 *             none shows a hard block with the best alternative.
 */
export function formatCannotAutomate(opts: {
  feature: string
  reason: string
  manualPath?: string
  fallback?: string
  tier?: AutomationTier
  neededFromDeveloper?: string
}): string {
  const tier = opts.tier ?? 'none'
  const lines: string[] = []

  if (tier === 'partial') {
    lines.push(`[PARTIALLY AUTOMATED] ${opts.feature}`)
    if (opts.fallback) {
      lines.push(`\n✓ What I'm doing now: ${opts.fallback}`)
    }
    lines.push(`\n⚡ Needs your input: ${opts.neededFromDeveloper ?? opts.reason}`)
    if (opts.manualPath) {
      lines.push(`How to get it: ${opts.manualPath}`)
    }
    lines.push('\nPaste it in chat and I\'ll activate the rest automatically.')
  } else if (tier === 'guided') {
    lines.push(`[MANUAL SETUP REQUIRED] ${opts.feature}`)
    lines.push(`\nReason: ${opts.reason}`)
    if (opts.manualPath) {
      lines.push(`\nStep-by-step: ${opts.manualPath}`)
    }
    if (opts.fallback) {
      lines.push(`\nWhat I can do after: ${opts.fallback}`)
    }
  } else {
    lines.push(`[CANNOT DO AUTOMATICALLY] ${opts.feature}`)
    lines.push(`Reason: ${opts.reason}`)
    if (opts.manualPath) {
      lines.push(`Manual path: ${opts.manualPath}`)
    }
    if (opts.fallback) {
      lines.push(`What I can do now instead: ${opts.fallback}`)
    }
  }

  return lines.join('\n')
}

/**
 * Build a tier-aware capability boundary message from a manifest entry.
 */
export function formatCapabilityBlock(featureKey: string, featureLabel: string): string {
  const entry = CAPABILITY_MANIFEST[featureKey]
  if (!entry || entry.automatable) return ''
  return formatCannotAutomate({
    feature: featureLabel,
    reason: entry.blockedReason ?? 'This feature requires manual configuration',
    manualPath: entry.manualPath,
    fallback: entry.fallback,
    tier: entry.automationTier,
    neededFromDeveloper: entry.neededFromDeveloper,
  })
}

/**
 * Returns the automation tier for a feature, or 'full' if not in the manifest.
 */
export function getAutomationTier(featureKey: string): AutomationTier {
  return CAPABILITY_MANIFEST[featureKey]?.automationTier ?? 'full'
}
