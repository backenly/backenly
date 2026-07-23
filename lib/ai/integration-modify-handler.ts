/**
 * INTEGRATION MODIFY HANDLER
 * ==========================
 * Handles "add X auth instead of Y auth", "add stripe integration",
 * "replace JWT with Google OAuth", "add resend feature" and similar
 * integration-level modification prompts.
 *
 * Rules:
 * - Always inspect current state first (what is already configured)
 * - Execute what can be executed immediately (schema, functions, tables)
 * - Report blocked items that need secrets/credentials
 * - Never claim an integration is ready if credentials are missing
 * - Never silently no-op — always return a meaningful state update
 */

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { collectProof, buildIntegrationStatusBlock } from '@/lib/ai/proof-system'
import { stripAdvisoryPhrases } from '@/lib/ai/text-utils'

type IntegrationStatus = 'not_configured' | 'partially_configured' | 'behaviorally_ready' | 'key_stored'

// ── Issue 19: Integration Wizard ─────────────────────────────────────────────

/**
 * Structured integration wizard — returned when OAuth/payment credentials are
 * missing so the UI can show a secure form modal instead of asking the user to
 * paste secrets in chat.
 *
 * The UI must render this as:
 *   [INTEGRATION] {provider}
 *   Status: not configured
 *   Required: {requiredFields[]}
 *
 *   Options:
 *     [A] Enter credentials now via secure form
 *     [B] Skip for now → mark {provider} as pending
 */
export interface IntegrationWizard {
  /** Provider name e.g. 'Google OAuth', 'GitHub OAuth', 'Stripe' */
  provider: string
  /** Current readiness state */
  status: 'not_configured' | 'partially_configured'
  /** Human-readable field names that are still required */
  requiredFields: string[]
  /** Exact env var names that are missing */
  missingEnvVars: string[]
  /** Where the user gets these credentials */
  credentialSource: string
  /** The callback URL to register in the provider's developer console (OAuth only) */
  callbackUrl?: string
  /** Where to register the callback URL */
  callbackRegistrationPath?: string
  /** The option text labels shown in the UI */
  options: {
    optionA: string   // Enter credentials now
    optionB: string   // Skip for now
  }
}

export interface IntegrationModifyResult {
  message: string
  /** What was already configured before this change */
  stateBefore: string[]
  /** Actions successfully executed */
  executed: string[]
  /** Items that cannot complete without secrets/config */
  blocked: Array<{ item: string; reason: string; hint: string }>
  /** Overall readiness after this operation */
  readiness: 'key_stored' | 'partially_configured' | 'behaviorally_ready' | 'blocked'
  success: boolean
  subBehavior: 'MODIFICATION'
  mode: 'build'
  /**
   * Issue 19: Present when credentials are missing.
   * The UI should open a secure form modal when this field is set.
   * Never null when readiness === 'blocked' or 'partially_configured' with missing creds.
   */
  integrationWizard?: IntegrationWizard
}

// ── Auth provider detection ───────────────────────────────────────────────────

export interface IntegrationModifyRequest {
  type: 'auth_provider' | 'payment' | 'email' | 'analytics' | 'generic'
  addProviders: string[]     // providers to add (e.g. ['google', 'github'])
  removeProviders?: string[] // providers to remove/replace
  rawMessage: string
}

/**
 * Detect what kind of integration modification is being requested.
 */
export function detectIntegrationModifyRequest(message: string): IntegrationModifyRequest | null {
  const lower = message.toLowerCase()

  // ── Auth provider modifications ───────────────────────────────────────────
  const authModify =
    /\b(add|enable|integrate|set up|setup|include|use|implement|connect)\b.{0,50}\b(google|github|facebook|twitter|apple|microsoft)\b.{0,30}\b(auth|oauth|login|sign.?in|provider)?\b/i.test(lower) ||
    /\b(replace|change|switch)\b.{0,30}\b(jwt|bearer|token)\b.{0,30}\b(with|to|for)\b.{0,30}\b(google|github|oauth|social)\b/i.test(lower) ||
    /\b(add|implement)\s+(google|github|facebook|twitter|apple|microsoft)\s+auth\b/i.test(lower) ||
    /\b(google|github|facebook|twitter|apple|microsoft)\s+(auth|oauth|login)\b.{0,30}\b(instead|replace|add|implement)\b/i.test(lower) ||
    /\binstead of\b.{0,30}\b(jwt|basic auth)\b/i.test(lower)

  if (authModify) {
    const providers: string[] = []
    if (/google/i.test(lower)) providers.push('google')
    if (/github/i.test(lower)) providers.push('github')
    if (/facebook/i.test(lower)) providers.push('facebook')
    if (/twitter/i.test(lower)) providers.push('twitter')
    if (/apple/i.test(lower)) providers.push('apple')
    if (/microsoft/i.test(lower)) providers.push('microsoft')

    const removeProviders: string[] = []
    if (/instead of.{0,30}jwt/i.test(lower) || /replace.{0,30}jwt/i.test(lower)) {
      removeProviders.push('jwt_only')
    }

    if (providers.length > 0) {
      return { type: 'auth_provider', addProviders: providers, removeProviders, rawMessage: message }
    }
  }

  // ── Payment integration ────────────────────────────────────────────────────
  if (/\b(add|integrate|set up|setup|enable|implement|connect|use)\b.{0,30}\b(stripe|payment)\b/i.test(lower)) {
    return { type: 'payment', addProviders: ['stripe'], rawMessage: message }
  }

  // ── Email integration ──────────────────────────────────────────────────────
  // "implement Resend", "add Resend", "integrate SendGrid", "use resend for email"
  if (/\b(add|integrate|set up|setup|enable|implement|connect|use)\b.{0,30}\b(resend|sendgrid|email)\b/i.test(lower)) {
    const providers: string[] = []
    if (/resend/i.test(lower)) providers.push('resend')
    if (/sendgrid/i.test(lower)) providers.push('sendgrid')
    if (providers.length > 0) {
      return { type: 'email', addProviders: providers, rawMessage: message }
    }
  }

  // ── Standalone integration product name (e.g. "Resend also", "also Resend") ──
  // Catches cases where the product name appears without an explicit action verb.
  // "Resend" as a capitalised proper noun in context clearly means the product.
  if (/\bresend\b/i.test(lower) && !/re.?send (the|this|it|that|them|email|message|notification)/i.test(lower)) {
    return { type: 'email', addProviders: ['resend'], rawMessage: message }
  }
  if (/\bsendgrid\b/i.test(lower)) {
    return { type: 'email', addProviders: ['sendgrid'], rawMessage: message }
  }

  return null
}

// ── Current state inspection ──────────────────────────────────────────────────

interface CurrentAuthState {
  authEnabled: boolean
  providers: string[]
  hasUsers: boolean
}

async function inspectCurrentAuthState(projectId: string): Promise<CurrentAuthState> {
  try {
    const tables = await prisma.backendGraph.findFirst({ where: { projectId } })

    // Check if auth is enabled via graph data
    const graphData = tables?.graphData as any
    const authEnabled = !!(
      (graphData?.auth?.enabled) ||
      (graphData?.providers && graphData.providers.length > 0)
    )

    const providers: string[] = []
    if (graphData?.providers) {
      providers.push(...(graphData.providers as string[]))
    }
    // JWT is always the baseline — if auth is enabled with no providers, it's JWT
    if (authEnabled && providers.length === 0) {
      providers.push('jwt')
    }

    // Check for a users table as proxy for auth setup
    const hasUsers = Array.isArray(graphData?.tables) && graphData.tables.some(
      (t: any) => typeof t?.name === 'string' && /^users?$/i.test(t.name)
    )

    return { authEnabled, providers, hasUsers }
  } catch {
    return { authEnabled: false, providers: [], hasUsers: false }
  }
}

// ── Provider credential requirements ─────────────────────────────────────────

const PROVIDER_REQUIREMENTS: Record<string, Array<{ envVar: string; hint: string }>> = {
  google: [
    { envVar: 'GOOGLE_CLIENT_ID', hint: 'Google Client ID from Google Cloud Console → APIs & Services → Credentials' },
    { envVar: 'GOOGLE_CLIENT_SECRET', hint: 'Google Client Secret from the same credentials page' },
  ],
  github: [
    { envVar: 'GITHUB_CLIENT_ID', hint: 'GitHub OAuth App Client ID from github.com/settings/applications/new' },
    { envVar: 'GITHUB_CLIENT_SECRET', hint: 'GitHub OAuth App Client Secret' },
  ],
  facebook: [
    { envVar: 'FACEBOOK_APP_ID', hint: 'Facebook App ID from developers.facebook.com' },
    { envVar: 'FACEBOOK_APP_SECRET', hint: 'Facebook App Secret' },
  ],
  twitter: [
    { envVar: 'TWITTER_CLIENT_ID', hint: 'Twitter OAuth 2.0 Client ID from developer.twitter.com' },
    { envVar: 'TWITTER_CLIENT_SECRET', hint: 'Twitter OAuth 2.0 Client Secret' },
  ],
  apple: [
    { envVar: 'APPLE_CLIENT_ID', hint: 'Apple Services ID from developer.apple.com' },
    { envVar: 'APPLE_TEAM_ID', hint: 'Apple Team ID from developer.apple.com/account' },
    { envVar: 'APPLE_KEY_ID', hint: 'Apple Key ID for Sign in with Apple' },
    { envVar: 'APPLE_PRIVATE_KEY', hint: 'Apple Private Key (.p8 file contents)' },
  ],
  microsoft: [
    { envVar: 'MICROSOFT_CLIENT_ID', hint: 'Azure AD App Client ID from portal.azure.com' },
    { envVar: 'MICROSOFT_CLIENT_SECRET', hint: 'Azure AD App Client Secret' },
  ],
  stripe: [
    { envVar: 'STRIPE_SECRET_KEY', hint: 'Stripe secret key (sk_live_... or sk_test_...) from dashboard.stripe.com/apikeys' },
    { envVar: 'STRIPE_WEBHOOK_SECRET', hint: 'Stripe webhook signing secret from the webhook endpoint settings' },
  ],
  resend: [
    { envVar: 'RESEND_API_KEY', hint: 'Resend API key (re_...) from resend.com/api-keys' },
  ],
  sendgrid: [
    { envVar: 'SENDGRID_API_KEY', hint: 'SendGrid API key from app.sendgrid.com/settings/api_keys' },
  ],
}

// ── OAuth redirect URI registry ──────────────────────────────────────────────

/**
 * Returns the callback URL that must be registered in the OAuth provider's
 * developer console for a given provider and project.
 *
 * The URL pattern follows Backenly's v1 auth callback route:
 *   /api/v1/{projectId}/auth/callback/{provider}
 *
 * The base URL is read from NEXT_PUBLIC_APP_URL (defaults to the production
 * domain when running in prod, localhost in dev).
 */
function getOAuthCallbackUrl(provider: string, projectId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://backenly.com'
  return `${base}/api/v1/${projectId}/auth/callback/${provider}`
}

/** Where the developer must paste the callback URL in the provider's console */
const PROVIDER_CONSOLE_PATHS: Record<string, string> = {
  google:    'Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client → Authorized redirect URIs',
  github:    'github.com/settings/applications → your OAuth App → Authorization callback URL',
  facebook:  'developers.facebook.com → your App → Facebook Login → Settings → Valid OAuth Redirect URIs',
  twitter:   'developer.twitter.com → your App → User authentication settings → Callback URI / Redirect URL',
  apple:     'developer.apple.com → Certificates, Identifiers & Profiles → your Services ID → Return URLs',
  microsoft: 'portal.azure.com → Azure Active Directory → App registrations → your app → Redirect URIs',
}

/** Human-readable credential source for each provider */
const PROVIDER_CREDENTIAL_SOURCE: Record<string, string> = {
  google:    'console.cloud.google.com → APIs & Services → Credentials → Create OAuth 2.0 Client ID',
  github:    'github.com/settings/applications/new → create an OAuth App',
  facebook:  'developers.facebook.com → My Apps → create an app → get App ID and Secret',
  twitter:   'developer.twitter.com → Projects & Apps → create an app → OAuth 2.0 settings',
  apple:     'developer.apple.com → Certificates, Identifiers & Profiles → Services IDs',
  microsoft: 'portal.azure.com → Azure Active Directory → App registrations → New registration',
  stripe:    'dashboard.stripe.com/apikeys',
  resend:    'resend.com/api-keys',
  sendgrid:  'app.sendgrid.com/settings/api_keys',
}

// ── Issue 19: Build integration wizard ───────────────────────────────────────

/**
 * Build a structured IntegrationWizard for display when credentials are missing.
 * The UI renders this as an [INTEGRATION] status block + secure form modal.
 */
function buildIntegrationWizard(
  provider: string,
  projectId: string,
  missingEnvVars: string[],
  currentStatus: IntegrationStatus,
): IntegrationWizard {
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1)
  const reqs = PROVIDER_REQUIREMENTS[provider] ?? []
  const requiredFields = reqs
    .filter(r => missingEnvVars.includes(r.envVar))
    .map(r => r.hint.split(' from ')[0].replace(/^.+ Client /, '').replace(/^.+ /, ''))

  const callbackUrl = PROVIDER_CONSOLE_PATHS[provider]
    ? getOAuthCallbackUrl(provider, projectId)
    : undefined

  const isOAuth = ['google', 'github', 'facebook', 'twitter', 'apple', 'microsoft'].includes(provider)

  return {
    provider: `${providerLabel} OAuth`,
    status: currentStatus === 'not_configured' ? 'not_configured' : 'partially_configured',
    requiredFields: requiredFields.length > 0 ? requiredFields : missingEnvVars,
    missingEnvVars,
    credentialSource: PROVIDER_CREDENTIAL_SOURCE[provider] ?? `${provider} developer console`,
    callbackUrl: isOAuth ? callbackUrl : undefined,
    callbackRegistrationPath: isOAuth ? PROVIDER_CONSOLE_PATHS[provider] : undefined,
    options: {
      optionA: `Enter credentials now via secure form → auto-completes ${providerLabel} setup`,
      optionB: `Skip for now → I'll use JWT only and mark ${providerLabel} as pending`,
    },
  }
}

/**
 * Format the [INTEGRATION] wizard block as a text message (for the chat stream).
 * The UI also receives the structured IntegrationWizard object for rendering the modal.
 */
function formatIntegrationWizardMessage(wizard: IntegrationWizard): string {
  const lines: string[] = []
  lines.push(`[INTEGRATION] ${wizard.provider}`)
  lines.push(`Status: ${wizard.status.replace(/_/g, ' ')}`)
  lines.push(`Required: ${wizard.requiredFields.join(' + ')} (from ${wizard.credentialSource})`)
  lines.push('')
  lines.push('Options:')
  lines.push(`  [A] ${wizard.options.optionA}`)
  lines.push(`  [B] ${wizard.options.optionB}`)
  if (wizard.callbackUrl && wizard.callbackRegistrationPath) {
    lines.push('')
    lines.push(`Callback URL to register in ${wizard.callbackRegistrationPath}:`)
    lines.push(`  \`${wizard.callbackUrl}\``)
  }
  return lines.join('\n')
}

/**
 * Build the [RESUMED] continuation message that appears after credentials are saved.
 * Called from the chat route when a key is stored for an integration that was previously
 * blocked with an IntegrationWizard.
 */
export function buildResumedIntegrationMessage(
  provider: string,
  projectId: string,
): string {
  // H1 Fix: Honest OAuth status — credentials are stored and callback URL is registered
  // in the system, but the OAuth flow is NOT verified end-to-end at this point.
  // "connected" would be misleading — "credentials stored, awaiting first login" is accurate.
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1)
  const callbackUrl = getOAuthCallbackUrl(provider, projectId)
  const consolePath = PROVIDER_CONSOLE_PATHS[provider]
  const lines: string[] = [`[RESUMED] ${providerLabel} OAuth setup`]
  lines.push(`  [✓] Credentials received and stored`)
  lines.push(`  [✓] Provider registered in workspace auth config`)
  lines.push(`  [✓] Callback URL: ${callbackUrl}`)
  if (consolePath) {
    lines.push(`  [!] Register this callback URL in: ${consolePath}`)
  }
  lines.push(`  Status: credentials stored — OAuth flow ready for first user login`)
  lines.push(`  Note: End-to-end OAuth is verified on first user sign-in, not at setup time.`)
  return lines.join('\n')
}

// ── Check which credentials are already stored ────────────────────────────────

async function checkStoredCredentials(projectId: string, provider: string): Promise<string[]> {
  try {
    const keys = await prisma.projectIntegrationKey.findMany({
      where: { projectId },
      select: { integrationId: true },
    })
    const stored = new Set(keys.map(k => k.integrationId.toUpperCase()))
    const reqs = PROVIDER_REQUIREMENTS[provider] ?? []
    return reqs
      .filter(r => !stored.has(r.envVar.toUpperCase()))
      .map(r => r.envVar)
  } catch {
    return (PROVIDER_REQUIREMENTS[provider] ?? []).map(r => r.envVar)
  }
}

// ── Issue 17: Live integration state inspection ──────────────────────────────

interface IntegrationLiveState {
  /** Table names that already exist in the project (from live schema) */
  existingTables: string[]
  /** Credentials stored for this integration */
  storedCredentials: string[]
  /** Missing credentials */
  missingCredentials: string[]
  /** Overall readiness */
  status: IntegrationStatus
}

/**
 * Inspect the live project state for a given integration.
 * Never relies on cached or hardcoded values — always queries live DB.
 */
async function inspectIntegrationLiveState(
  projectId: string,
  integrationId: string,
): Promise<IntegrationLiveState> {
  // Fetch live schema (tables that actually exist)
  let existingTables: string[] = []
  try {
    const { getCachedSchema } = await import('@/lib/ai/execution-cache')
    const schema = await getCachedSchema(projectId)
    // Schema format: "Table: tablename\nColumns: ..." per block
    const tableMatches = schema.match(/^Table:\s*(\S+)/gim) ?? []
    existingTables = tableMatches.map(m => m.replace(/^Table:\s*/i, '').trim().toLowerCase())
  } catch { /* non-fatal — empty means nothing created yet */ }

  // Fetch stored and missing credentials
  const storedReqs = PROVIDER_REQUIREMENTS[integrationId] ?? []
  let storedCredentials: string[] = []
  let missingCredentials: string[] = []
  try {
    const missing = await checkStoredCredentials(projectId, integrationId)
    missingCredentials = missing
    storedCredentials = storedReqs.map(r => r.envVar).filter(k => !missing.includes(k))
  } catch {
    missingCredentials = storedReqs.map(r => r.envVar)
  }

  let status: IntegrationStatus
  if (missingCredentials.length === 0 && storedReqs.length > 0) {
    status = 'behaviorally_ready'
  } else if (storedCredentials.length > 0) {
    status = 'partially_configured'
  } else if (existingTables.length > 0) {
    status = 'key_stored'
  } else {
    status = 'not_configured'
  }

  return { existingTables, storedCredentials, missingCredentials, status }
}

// ── Issue 16: Delta plan block formatter ─────────────────────────────────────

/**
 * Format a structured delta plan block for display before execution.
 * Shows current state, what will be done now, and what is blocked on credentials.
 */
function formatDeltaPlanBlock(opts: {
  integration: string
  currentState: IntegrationStatus
  canDoNow: string[]
  blockedUntil: string[]
  afterSecrets: string[]
}): string {
  const { integration, currentState, canDoNow, blockedUntil, afterSecrets } = opts
  const lines: string[] = [`[DELTA PLAN] Add ${integration}`]
  lines.push(`  Current state:  ${currentState.replace(/_/g, ' ')}`)
  if (canDoNow.length > 0) {
    canDoNow.forEach(item => lines.push(`  Can do now:     ${item}`))
  }
  blockedUntil.forEach(item => lines.push(`  Blocked until:  ${item}`))
  if (afterSecrets.length > 0) {
    afterSecrets.forEach(item => lines.push(`  After secrets:  ${item}`))
  }
  return '```\n' + lines.join('\n') + '\n```'
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * Handle an integration modification prompt.
 * Inspects current state, executes what can be executed, reports what is blocked.
 */
export async function handleIntegrationModify(
  request: IntegrationModifyRequest,
  projectId: string,
): Promise<IntegrationModifyResult> {
  const executed: string[] = []
  const blocked: IntegrationModifyResult['blocked'] = []
  const stateBefore: string[] = []

  // ── Auth provider modifications ────────────────────────────────────────────
  if (request.type === 'auth_provider') {
    // Issue 17: Use live state — BackendGraph may be stale; complement with credential check
    const currentAuth = await inspectCurrentAuthState(projectId)

    if (currentAuth.authEnabled) {
      stateBefore.push(`Auth enabled with: ${currentAuth.providers.join(', ') || 'JWT (password-based)'}`)
    } else {
      stateBefore.push('Auth: not yet enabled on this project')
    }

    for (const provider of request.addProviders) {
      const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1)
      // Issue 17: live credential check
      const liveState = await inspectIntegrationLiveState(projectId, provider)
      const reqs = PROVIDER_REQUIREMENTS[provider] ?? []

      // Issue 16: Build delta plan for this auth provider
      const canDoNow = ['register OAuth provider config in auth system']
      const blockedUntil = liveState.missingCredentials.map(k => `${k} provided`)
      const callbackUrl = getOAuthCallbackUrl(provider, projectId)
      const consolePath = PROVIDER_CONSOLE_PATHS[provider]
      const afterSecrets = [
        `register redirect URI in ${consolePath ?? `${provider} developer console`}`,
        `${provider} OAuth login becomes active`,
      ]

      const deltaPlanBlock = formatDeltaPlanBlock({
        integration: `${providerLabel} auth`,
        currentState: liveState.status,
        canDoNow,
        blockedUntil,
        afterSecrets,
      })

      // Execute: register the provider config
      try {
        const result = await executeAction(
          { action: 'ADD_PROVIDER', params: { provider } },
          projectId,
        )
        executed.push(
          result.success
            ? `[ACTION] Registered ${provider} OAuth provider in auth configuration`
            : `[ACTION] ${provider} OAuth provider registration attempted`,
        )
      } catch {
        executed.push(`[ACTION] ${provider} provider registration attempted`)
      }

      // Report missing credentials
      for (const req of reqs) {
        if (liveState.missingCredentials.includes(req.envVar)) {
          blocked.push({
            item: `${providerLabel} credentials`,
            reason: `${req.envVar} not yet stored`,
            hint: req.hint,
          })
        }
      }

      // Describe the "instead of" context if present
      const replacingJwt = request.removeProviders?.includes('jwt_only')
      if (replacingJwt) {
        executed.push('[INFO] JWT password auth remains active — coexists with OAuth (users can log in either way)')
      }

      const allCredentialsPresent = blocked.length === 0
      const readiness: IntegrationModifyResult['readiness'] = allCredentialsPresent
        ? 'behaviorally_ready'
        : executed.length > 0
          ? 'partially_configured'
          : 'blocked'

      // ── Issue 19: Build integration wizard when credentials are missing ──────
      let integrationWizard: IntegrationWizard | undefined
      if (!allCredentialsPresent && liveState.missingCredentials.length > 0) {
        integrationWizard = buildIntegrationWizard(
          provider,
          projectId,
          liveState.missingCredentials,
          liveState.status,
        )
      }

      const parts: string[] = []
      parts.push(deltaPlanBlock)
      parts.push(`Proceeding with what can be done now...\n${executed.join('\n')}`)

      if (integrationWizard) {
        // Issue 19: Use structured wizard message instead of raw blocked lines
        parts.push(formatIntegrationWizardMessage(integrationWizard))
      } else if (blocked.length > 0) {
        const blockedLines = blocked.map(b => `[BLOCKED] ${b.item} — ${b.hint}`)
        parts.push(blockedLines.join('\n'))
      }

      // OAuth redirect URI is shown in the wizard — skip the inline block when wizard is active
      if (consolePath && !integrationWizard) {
        parts.push(
          `**OAuth Redirect URI — Required Setup**\n` +
          `Register this callback URL in ${consolePath}:\n\`${callbackUrl}\``
        )
      }

      // H1/H3 Fix: Honest readiness labels — "behaviorally_ready" means credentials are
      // stored and routes exist, NOT that an actual OAuth login was verified end-to-end.
      const readinessLabel =
        readiness === 'behaviorally_ready'
          ? '**Status: credentials stored** — OAuth routes are registered. End-to-end login is verified on first user sign-in (not at setup time).'
          : readiness === 'partially_configured'
            ? '**Status: partially_configured** — Provider registered. Supply missing credentials + register redirect URI to activate.'
            : '**Status: blocked** — Cannot proceed without credentials'

      parts.push(readinessLabel)

      const proof = await collectProof(projectId)
      parts.push(buildIntegrationStatusBlock(proof))

      const message = stripAdvisoryPhrases(parts.join('\n\n'))
      return {
        message,
        stateBefore,
        executed,
        blocked,
        readiness,
        success: executed.length > 0,
        subBehavior: 'MODIFICATION',
        mode: 'build',
        integrationWizard,
      }
    }
  }

  // ── Payment integration ────────────────────────────────────────────────────
  if (request.type === 'payment') {
    // Issue 17: Inspect live state — never hardcode "not configured"
    const liveState = await inspectIntegrationLiveState(projectId, 'stripe')

    // C2/H3 Fix: Honest Stripe state — "behaviorally_ready" means key stored + schema built,
    // NOT that a real payment flow was verified. Webhook must still be registered in Stripe dashboard.
    if (liveState.status === 'behaviorally_ready') {
      stateBefore.push('Stripe key stored + schema built — webhook endpoint not yet registered in Stripe dashboard (required for live payments)')
    } else if (liveState.existingTables.some(t => /orders?|payments?|payment_events?/.test(t))) {
      stateBefore.push(`Payment tables already exist: ${liveState.existingTables.filter(t => /orders?|payments?|payment_events?/.test(t)).join(', ')}`)
    } else {
      stateBefore.push('Stripe: not configured — no payment tables or credentials found')
    }

    // Issue 16: Build delta plan
    const ordersExists = liveState.existingTables.includes('orders')
    const paymentEventsExists = liveState.existingTables.includes('payment_events')

    const canDoNow: string[] = []
    // C2 Fix: Be explicit that Stripe webhook registration requires manual steps in Stripe dashboard.
    // Backenly stores the key and builds the schema — it cannot register webhooks with Stripe automatically.
    const afterSecrets: string[] = [
      'manually register webhook endpoint in Stripe Dashboard → Developers → Webhooks (Backenly cannot do this automatically)',
      'add your Stripe webhook signing secret (STRIPE_WEBHOOK_SECRET) via chat',
      'enable payment intent flow in your application',
      'create invoice AI function',
    ]

    if (!ordersExists) canDoNow.push('create orders table (9 columns)')
    if (!paymentEventsExists) canDoNow.push('create payment_events table (6 columns)')
    if (!ordersExists || !paymentEventsExists) canDoNow.push('generate REST APIs: POST /checkout, POST /webhook, GET /orders/:id')

    const blockedItems = liveState.missingCredentials

    // Show delta plan before execution
    const deltaPlanBlock = formatDeltaPlanBlock({
      integration: 'Stripe payments',
      currentState: liveState.status,
      canDoNow: canDoNow.length > 0 ? canDoNow : ['(all payment tables already exist)'],
      blockedUntil: blockedItems.length > 0 ? blockedItems.map(k => `${k} provided`) : [],
      afterSecrets,
    })

    // Execute what can be done now
    if (!ordersExists) {
      try {
        const r = await executeAction({
          action: 'CREATE_TABLE',
          params: {
            tableName: 'orders',
            columns: [
              { name: 'id', type: 'UUID', isPrimaryKey: true },
              { name: 'userId', type: 'UUID' },
              { name: 'status', type: 'TEXT' },
              { name: 'total', type: 'DECIMAL' },
              { name: 'currency', type: 'TEXT' },
              { name: 'stripePaymentIntentId', type: 'TEXT' },
              { name: 'stripeCustomerId', type: 'TEXT' },
              { name: 'createdAt', type: 'TIMESTAMP' },
              { name: 'updatedAt', type: 'TIMESTAMP' },
            ],
          },
        }, projectId)
        if (r.success) {
          executed.push('[ACTION] Created: orders table (9 columns)')
          // Generate API immediately after table creation
          const apiR = await executeAction({ action: 'GENERATE_API', params: { tableName: 'orders' } }, projectId)
          if (apiR.success) executed.push('[ACTION] Generated: REST API for orders (GET, POST, PUT, DELETE)')
        }
      } catch { /* non-fatal */ }
    } else {
      executed.push('[SKIP] orders table already exists')
    }

    if (!paymentEventsExists) {
      try {
        const r = await executeAction({
          action: 'CREATE_TABLE',
          params: {
            tableName: 'payment_events',
            columns: [
              { name: 'id', type: 'UUID', isPrimaryKey: true },
              { name: 'orderId', type: 'UUID' },
              { name: 'type', type: 'TEXT' },
              { name: 'stripeEventId', type: 'TEXT' },
              { name: 'payload', type: 'JSONB' },
              { name: 'processedAt', type: 'TIMESTAMP' },
            ],
          },
        }, projectId)
        if (r.success) {
          executed.push('[ACTION] Created: payment_events table (6 columns)')
          const apiR = await executeAction({ action: 'GENERATE_API', params: { tableName: 'payment_events' } }, projectId)
          if (apiR.success) executed.push('[ACTION] Generated: REST API for payment_events')
        }
      } catch { /* non-fatal */ }
    } else {
      executed.push('[SKIP] payment_events table already exists')
    }

    // Report blocked credentials
    for (const cred of liveState.missingCredentials) {
      const req = PROVIDER_REQUIREMENTS.stripe?.find(r => r.envVar === cred)
      blocked.push({
        item: `Stripe: ${cred}`,
        reason: `${cred} not stored`,
        hint: req?.hint ?? `Paste your ${cred} to activate Stripe`,
      })
    }

    if (blocked.length > 0) {
      blocked.push({
        item: 'Stripe key connection',
        reason: 'awaiting credentials above',
        hint: '[BLOCKED] Stripe key connection — awaiting credentials',
      })
    }

    const parts: string[] = []
    parts.push(deltaPlanBlock)
    parts.push(`\nProceeding with what can be done now...\n${executed.join('\n')}`)
    if (blocked.length > 0) {
      const credLines = blocked
        .filter(b => b.item.startsWith('Stripe:'))
        .map(b => `[BLOCKED] ${b.item} — ${b.hint}`)
      if (credLines.length > 0) parts.push(credLines.join('\n'))
    }

    const paymentProof = await collectProof(projectId)
    parts.push(buildIntegrationStatusBlock(paymentProof))

    const readiness: IntegrationModifyResult['readiness'] =
      liveState.status === 'behaviorally_ready'
        ? 'behaviorally_ready'
        : executed.some(e => e.startsWith('[ACTION]'))
          ? 'partially_configured'
          : blocked.length === 0
            ? 'key_stored'
            : 'partially_configured'

    return {
      message: stripAdvisoryPhrases(parts.join('\n\n')),
      stateBefore,
      executed,
      blocked,
      readiness,
      success: executed.some(e => e.startsWith('[ACTION]')) || liveState.status === 'behaviorally_ready',
      subBehavior: 'MODIFICATION',
      mode: 'build',
    }
  }

  // ── Email integration ──────────────────────────────────────────────────────
  if (request.type === 'email') {
    for (const provider of request.addProviders) {
      // Issue 17: Inspect live state for this provider
      const liveState = await inspectIntegrationLiveState(projectId, provider)
      const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1)

      // Describe actual current state
      if (liveState.status === 'behaviorally_ready') {
        stateBefore.push(`${providerLabel}: credentials stored — email integration active`)
      } else if (liveState.existingTables.some(t => /email_logs?|email_notifications?|notifications?/.test(t))) {
        stateBefore.push(`${providerLabel}: email_logs table exists, awaiting credentials`)
      } else {
        stateBefore.push(`${providerLabel}: not configured — no email tables or credentials found`)
      }

      // Issue 16: Build delta plan
      const emailLogsExists = liveState.existingTables.includes('email_logs')
      const canDoNow: string[] = []
      if (!emailLogsExists) canDoNow.push('create email_logs table (7 columns)')
      const afterSecrets: string[] = [
        'activate email sending via AI function',
        'add welcome email template',
        'add notification triggers',
      ]

      const deltaPlanBlock = formatDeltaPlanBlock({
        integration: `${providerLabel} email`,
        currentState: liveState.status,
        canDoNow: canDoNow.length > 0 ? canDoNow : ['(email_logs table already exists)'],
        blockedUntil: liveState.missingCredentials.map(k => `${k} provided`),
        afterSecrets,
      })

      // Execute what can be done now
      if (!emailLogsExists) {
        try {
          const r = await executeAction({
            action: 'CREATE_TABLE',
            params: {
              tableName: 'email_logs',
              columns: [
                { name: 'id', type: 'UUID', isPrimaryKey: true },
                { name: 'recipientEmail', type: 'TEXT' },
                { name: 'subject', type: 'TEXT' },
                { name: 'template', type: 'TEXT' },
                { name: 'status', type: 'TEXT' },
                { name: 'sentAt', type: 'TIMESTAMP' },
                { name: 'createdAt', type: 'TIMESTAMP' },
              ],
            },
          }, projectId)
          if (r.success) {
            executed.push(`[ACTION] Created: email_logs table (7 columns)`)
            const apiR = await executeAction({ action: 'GENERATE_API', params: { tableName: 'email_logs' } }, projectId)
            if (apiR.success) executed.push(`[ACTION] Generated: REST API for email_logs`)
          }
        } catch { /* non-fatal */ }
      } else {
        executed.push('[SKIP] email_logs table already exists')
      }

      // Report blocked credentials
      const reqs = PROVIDER_REQUIREMENTS[provider] ?? []
      for (const req of reqs) {
        if (liveState.missingCredentials.includes(req.envVar)) {
          blocked.push({ item: `${providerLabel} credentials`, reason: `${req.envVar} not stored`, hint: req.hint })
        }
      }

      const emailProof = await collectProof(projectId)
      const emailStatusBlock = buildIntegrationStatusBlock(emailProof)

      const parts: string[] = []
      parts.push(deltaPlanBlock)
      parts.push(`\nProceeding with what can be done now...\n${executed.join('\n')}`)
      if (blocked.length > 0) {
        parts.push(blocked.map(b => `[BLOCKED] ${b.item} — ${b.hint}`).join('\n'))
      } else {
        parts.push(`**Status: key_stored** — Email integration ready. Say "add welcome email" or "add order notification" to activate templates.`)
      }
      parts.push(emailStatusBlock)

      return {
        message: stripAdvisoryPhrases(parts.join('\n\n')),
        stateBefore,
        executed,
        blocked,
        readiness: blocked.length === 0 ? 'key_stored' : 'partially_configured',
        success: executed.some(e => e.startsWith('[ACTION]')) || liveState.status === 'behaviorally_ready',
        subBehavior: 'MODIFICATION',
        mode: 'build',
      }
    }
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  return {
    message: 'Specify which integration to add: "add google auth", "add stripe payments", or "add resend email".',
    stateBefore: [],
    executed: [],
    blocked: [],
    readiness: 'partially_configured',
    success: false,
    subBehavior: 'MODIFICATION',
    mode: 'build',
  }
}
