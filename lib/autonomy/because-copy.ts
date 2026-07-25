/**
 * BECAUSE-COPY — one source of truth for "WHAT because WHY"
 * =========================================================
 *
 * Every autonomous-fix audit row carries a `findingType` and a `details` blob
 * (table name, column, etc.). The dashboard, activity feed, trust report,
 * toaster, "while you were away" banner, and email digest all need to render
 * the same row as a non-technical sentence. The rule from the product side:
 *
 *     "Backenly did X because Y."
 *
 * Without the WHY the loop reads as a glorified linter — the WHY is what makes
 * the user feel protected. Centralising the copy here means every surface
 * speaks the same language and a copy improvement lands everywhere at once.
 *
 * Pure. No DB. No side effects.
 */

/**
 * Union of every detail shape that can land in AuditLog.details for an
 * autonomy-fix row. There are three writers in the codebase:
 *
 *   1. HEALTH_AUTO_FIXED        (auto-fix-engine)   → {findingType, ...}
 *   2. AGENT_AUTO_FIXED         (agent-orchestrator) → {title, category, location}
 *   3. FIX_PLAN_AUTO_EXECUTED   (auto-fix-engine plan path) → {action, target, message}
 *
 * Every field is optional so the resolver below can pick whichever signal is
 * present. Adding a writer without aligning its shape only degrades to the
 * default "Backenly fixed something" — never crashes.
 */
export interface AutonomyEventDetails {
  // Canonical (HEALTH_AUTO_FIXED) — what new writers should produce.
  findingType?: string
  type?: string
  tableName?: string
  table?: string
  location?: string
  columnName?: string
  column?: string
  reason?: string
  message?: string
  title?: string
  description?: string
  // Agent-orchestrator (AGENT_AUTO_FIXED).
  category?: string
  // Plan executor (FIX_PLAN_AUTO_EXECUTED).
  action?: string
  target?: string
}

/**
 * Resolve the canonical finding-type key from any of the writer shapes above.
 * Tries `findingType`/`type` first, then falls back to:
 *   • `category` (agent path) — categories are already named after finding types
 *   • the executor `action` name (plan path) — CREATE_INDEX → missing_fk_index, etc.
 */
function resolveKind(d: AutonomyEventDetails): string {
  const direct = (d.findingType ?? d.type ?? d.category ?? '').toString().toLowerCase()
  if (direct) return direct
  // Map plan-executor action names to the closest finding-type concept so the
  // copy module's switch can route them through the same branches.
  const action = (d.action ?? '').toString().toUpperCase()
  switch (action) {
    case 'CREATE_INDEX':       return 'missing_fk_index'
    case 'ADD_CONSTRAINT':     return 'missing_fk_constraint'
    case 'SET_PERMISSION':     return 'missing_rls'
    case 'FIX_API':
    case 'GENERATE_API':       return 'missing_api_definition'
    case 'SET_RATE_LIMIT':     return 'missing_rate_limit'
    case 'FIX_REALTIME':       return 'realtime_gap'
    case 'FIX_AUTH':           return 'auth_integrity_gap'
    default:                   return ''
  }
}

export interface BecauseSentence {
  /** Plain-English action verb sentence — what Backenly did. */
  what: string
  /** Plain-English business reason — why it mattered. */
  why: string
  /** "What because why." — what every surface should render. */
  full: string
  /** Stable lowercase finding-type slug (for icons / category routing). */
  kind: string
}

const PROTECT_FROM_NEGLECT = 'silent damage from going unnoticed'

function tableOf(d: AutonomyEventDetails): string | null {
  return (d.tableName ?? d.table ?? d.target ?? d.location ?? null) as string | null
}

function colOf(d: AutonomyEventDetails): string | null {
  return (d.columnName ?? d.column ?? null) as string | null
}

function pretty(name: string | null): string {
  if (!name) return 'a table'
  // strip schema prefix and quotes for readability
  return name.replace(/^.*\./, '').replace(/["`]/g, '')
}

/**
 * Map a finding type + its details into a "what because why" sentence pair.
 *
 * Every branch returns BOTH parts. Missing branches fall back to a generic
 * sentence that still includes the type humanised, so the feed is never blank.
 */
export function explainAutonomyEvent(details: AutonomyEventDetails | null | undefined): BecauseSentence {
  const d = details ?? {}
  const kind = resolveKind(d)
  const table = tableOf(d)
  const col = colOf(d)
  const t = pretty(table)

  switch (kind) {
    case 'missing_fk_index': {
      const what = col
        ? `Backenly added an index on "${t}.${col}"`
        : `Backenly added a missing foreign-key index on "${t}"`
      const why =
        `the unindexed relationship would have turned every JOIN and filter ` +
        `into a full table scan once "${t}" had real traffic — a silent ` +
        `performance cliff at scale.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'missing_index':
    case 'query_pattern_missing_index': {
      const what = col
        ? `Backenly added an index on "${t}.${col}"`
        : `Backenly added a missing index on "${t}"`
      const why =
        `that column is filtered on a hot read path — without an index the ` +
        `query would have slowed to a crawl as the table grew.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'missing_fk_constraint':
    case 'missing_foreign_key': {
      const what = col
        ? `Backenly added a foreign-key constraint to "${t}.${col}"`
        : `Backenly added a missing foreign-key constraint to "${t}"`
      const why =
        `without it, deleting the referenced row would have left orphaned ` +
        `records behind — corruption that is expensive to unwind later.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'missing_rls':
    case 'unprotected_user_data':
    case 'weak_rls': {
      const what = `Backenly enabled row-level security on "${t}"`
      const why =
        `the table holds user-owned data and was readable across accounts — ` +
        `every signed-in user could see and modify everyone else's rows.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    // The mirror image of missing_rls, and it must NOT borrow that copy: this
    // table was not "readable across accounts", it was readable by nobody. A
    // repair note that describes an exposure a user never had teaches them to
    // distrust the queue.
    case 'rls_denies_everything': {
      const what = `Backenly installed a row-level-security policy on "${t}"`
      const why =
        `security was switched on with no policy at all, and PostgreSQL denies by default — ` +
        `so every read returned zero rows and every write was rejected. The table was dead ` +
        `to your app rather than protected.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'over_permissive_rls': {
      const what = `Backenly tightened a no-op RLS policy on "${t}"`
      const why =
        `the policy was effectively USING (true) — the table looked protected ` +
        `in every dashboard while exposing every row to everyone.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'missing_api_definition':
    case 'missing_api_crud':
    case 'api_drift': {
      const what = `Backenly regenerated the REST API for "${t}"`
      const why =
        `endpoints were missing or out of sync with the live schema — the ` +
        `frontend would have hit 404s and dead routes against shipped code.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'shadow_mutation': {
      const what = `Backenly reconciled an out-of-band schema change on "${t}"`
      const why =
        `a column was added outside the AI flow — drifting the live backend ` +
        `from its declared design and breaking reproducibility.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'unbounded_pagination': {
      const what = `Backenly bounded pagination on the list endpoint for "${t}"`
      const why =
        `the endpoint had no enforced limit — one bad query could return ` +
        `10,000+ rows and exhaust memory.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'missing_rate_limit':
    case 'rate_limit_gap': {
      const what = `Backenly added a rate limit to the hot endpoint on "${t}"`
      const why =
        `unbounded requests would have been the cheapest way for a bad actor ` +
        `to burn your quota or DoS the API.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'webhook_replay_risk': {
      const what = col
        ? `Backenly added "${col}" to "${t}" for webhook idempotency`
        : `Backenly added an idempotency key to "${t}"`
      const why =
        `duplicate webhook deliveries (retries, provider bugs) would have ` +
        `been processed twice — billing the same user twice, sending the ` +
        `same email twice.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'missing_archival_job':
    case 'stale_data_overflow': {
      // notify_only finding — Backenly cannot auto-pick the retention window.
      // Copy reflects suggestion, not action, so the activity feed stays honest.
      const what = `Backenly flagged "${t}" for an archival job`
      const why =
        `the table is filling with rows nobody reads anymore — left alone, ` +
        `it will slow every query against it and inflate storage cost month over month.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'missing_token_cleanup_cron':
    case 'expired_token_buildup': {
      // notify_only finding — needs the user to confirm cleanup cadence.
      const what = `Backenly flagged "${t}" for an expired-token cleanup cron`
      const why =
        `expired auth tokens are piling up — bloating the table and giving ` +
        `attackers a wider window of stolen credentials to brute-force.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'auth_integrity_gap':
    case 'missing_users_table':
    case 'missing_jwt_secret': {
      const what = `Backenly repaired the auth subsystem`
      const why =
        `a missing JWT secret or users table would have silently broken ` +
        `every end-user sign-in in the deployed app.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    case 'missing_retry_queue': {
      const what = `Backenly suggested an outbox/retry queue for async work`
      const why =
        `email and payment calls have no retry path — one network blip and ` +
        `the user never gets their receipt or confirmation email.`
      return { what, why, full: `${what} because ${why}`, kind }
    }

    default: {
      // Fallback path — never expose SCREAMING_SNAKE_CASE; always a sentence.
      const humanType = kind.replace(/_/g, ' ').trim() || 'a backend issue'
      const what = table
        ? `Backenly fixed ${humanType} on "${t}"`
        : `Backenly fixed ${humanType}`
      const why =
        d.reason && d.reason.length > 4
          ? d.reason
          : `it would have caused ${PROTECT_FROM_NEGLECT}.`
      return { what, why, full: `${what} because ${why}`, kind }
    }
  }
}

/**
 * Convenience — used by the toaster + banner where only the short headline
 * fits. Returns just the "what", with a fallback that still makes sense.
 */
export function shortHeadline(details: AutonomyEventDetails | null | undefined): string {
  return explainAutonomyEvent(details).what
}
