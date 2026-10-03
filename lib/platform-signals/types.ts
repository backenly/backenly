/**
 * PlatformSignals: Backenly's own business reactions to product events.
 *
 * The product tells this seam that something happened. What Backenly does about
 * it commercially is not the product's business, and in a self-hosted install
 * the answer is "nothing at all".
 *
 * ── How this differs from Entitlements ──────────────────────────────────────
 *
 * Entitlements answers "may this happen?" and owns the commercial mutations
 * that follow from a plan. PlatformSignals is the other half: the business
 * REACTION to something the product already did. Signup is the clearest case.
 * The product creates an account; whether that account earns a referral bonus,
 * counts toward a growth metric, or trips an abuse heuristic is Backenly's
 * concern, not the backend's.
 *
 * Where a reaction needs a commercial mutation, PlatformSignals decides and
 * Entitlements performs. Referral is exactly that shape: this seam decides an
 * attribution was earned, and the credit grant goes through the Cloud
 * entitlements provider.
 *
 * ── Deliberately not an event bus ───────────────────────────────────────────
 *
 * Each method here corresponds to a call family that already exists in the
 * tree. There is no publish(), no subscribe(), no string event names and no
 * registry. A generic bus would let anything be signalled from anywhere, which
 * is how a seam stops describing the system and starts hiding it. Adding a
 * method should require knowing what calls it.
 *
 * Every implementation must be safe to call in single-tenant, where all of this
 * is a no-op, and must never throw into the product path. A signal is something
 * that has already happened; failing to react to it cannot un-happen it.
 */

/** A brand-new account, just created by one of the signup flows. */
export interface SignupCompleted {
  userId: string
  email: string
  /** How the account was created. Matches the provider recorded on User. */
  provider: 'email' | 'google' | 'github' | 'microsoft'
  /**
   * The raw ?ref= code, from the form body or the backenly_ref cookie set when
   * the visitor landed on a referral link. Not normalised or validated here:
   * what counts as a valid code is Backenly's business rule, not the product's.
   */
  referralCode?: string | null
}

/** Who is trying to create an account. */
export interface SignupAttempt {
  email: string
  ip: string | null
}

/**
 * The verdict on a signup attempt.
 *
 * Carries the OUTCOME, never the reasoning. `score` and `signals` are recorded
 * against the account so an operator can see how it arrived, but how they were
 * computed stays private: publishing the heuristics publishes them to the
 * people they exist to catch.
 */
export interface SignupAdmission {
  ok: boolean
  reason: string
  status: number
  /** Allowed, but must verify its mailbox before it can consume anything. */
  untrusted?: boolean
  score?: number | null
  signals?: string[]
}

/**
 * Backenly's product funnel events.
 *
 * These land in ProductEvent, which is read by exactly one thing: the founder
 * admin console. They measure how Backenly's own funnel is doing, which a
 * self-hosted deployment has no stake in and no console to read.
 *
 * NOT to be confused with the deployment's own observability. Project logs,
 * runtime logs, monitoring and the SecurityEvent audit trail are product
 * functionality and stay public.
 */
export type ProductEventType =
  | 'signup'
  | 'project_created'
  | 'backend_generated'
  | 'frontend_connected'
  | 'deployed'
  | 'external_usage_started'
  | 'ai_prompt'
  | 'api_call'

export interface ProductEvent {
  type: ProductEventType
  userId: string
  projectId?: string | null
  metadata?: Record<string, unknown>
}

/** Daily usage counters, read only by the founder analytics pages. */
export interface UsageMetricsDelta {
  apiCalls?: number
  dbReads?: number
  dbWrites?: number
  aiCalls?: number
  computeTime?: number
}

/** A proof-of-humanity challenge presented at signup. */
export interface SignupChallenge {
  token: string | null | undefined
  ip: string | null
}

export interface ChallengeResult {
  ok: boolean
  /** Reason code when the check fails, for the security feed. */
  code?: 'missing_token' | 'invalid_token' | 'duplicate_token'
  reason?: string
  /** True when no provider is configured, so the caller can surface the gap. */
  unconfigured?: boolean
}

export interface PlatformSignalsProvider {
  /**
   * Verify a proof-of-humanity challenge.
   *
   * Cloud runs Turnstile. Single-tenant has no bot funnel to defend and no
   * Turnstile account, so it admits: the deployment is one team's
   * infrastructure and its registration is closed after the first account
   * anyway, which is a stronger control than any challenge.
   *
   * The public signup flow asks for the RESULT. It never imports the provider,
   * so OSS carries no Turnstile dependency at all.
   */
  verifySignupChallenge(challenge: SignupChallenge): Promise<ChallengeResult>

  /**
   * Record a funnel event.
   *
   * Fire-and-forget and returns void, not a promise: every caller is on a hot
   * path and the original logger was explicitly "safe to call without await".
   * Making this awaitable would invite someone to await it.
   */
  recordProductEvent(event: ProductEvent): void

  /** Increment the daily usage bucket. Fire-and-forget, same reasoning. */
  recordUsageMetrics(userId: string, projectId: string | undefined, delta: UsageMetricsDelta): void

  /**
   * Judge a signup Backenly has never seen before.
   *
   * Only reached in cloud, and only after the public gates have run: the
   * self-hosted slot, the kill switches and the operator blocklist all come
   * first, because those are decisions somebody made rather than a score
   * computed about a stranger.
   *
   * Single-tenant admits without judging. A self-hosted deployment has no
   * abuse funnel to defend and no reputation database to consult.
   */
  assessSignupAdmission(attempt: SignupAttempt): Promise<SignupAdmission>

  /**
   * Run Backenly's own scheduled commercial maintenance.
   *
   * Dunning today: expired payment-grace subscriptions get downgraded. This
   * is not a self-host job and must not become one. A single-tenant install
   * has no subscriptions to dun, so there is nothing here for it to run.
   *
   * The public scheduler owns the CADENCE and the private half owns the
   * WORK, which is what lets the billing cron routes move private without
   * the public scheduler ever importing them.
   */
  runScheduledBackOfficeMaintenance(): Promise<void>

  /**
   * React to a completed signup.
   *
   * Called after the account exists and before the session is issued. Must
   * never throw: signup has already succeeded by this point, and a failed
   * business reaction is not a reason to fail the request.
   */
  onSignupCompleted(event: SignupCompleted): Promise<void>
}
