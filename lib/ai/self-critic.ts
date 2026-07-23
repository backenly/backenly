/**
 * SELF-CRITIC PASS
 * ================
 * Before the final response goes to the user, run a completeness check:
 * "Did the result actually satisfy the original request?"
 *
 * Problem it solves (from the audit):
 *   User: "build a social app with posts, media uploads, and comments"
 *   AI:   Created posts, comments tables ← MISSED: storage buckets for media
 *   This is the #5 missing piece from the audit.
 *
 * How it works:
 *   1. Parse the original request for expected resource types
 *   2. Compare against what was actually built (artifact list)
 *   3. Return a list of gaps with auto-fix commands
 *   4. The caller can either auto-fix or surface the gap to the user
 *
 * Domain expectations:
 *   - "media" / "images" / "photos" / "uploads" → storage bucket expected
 *   - "auth" / "sign in" / "users" → auth system expected
 *   - "payments" / "stripe" → orders + payment tables expected
 *   - "realtime" / "live" / "chat" → realtime subscription expected
 *   - "notifications" → notifications table expected
 *   - "analytics" / "dashboard" → reporting endpoints expected
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExpectedResource {
  type: 'storage' | 'auth' | 'table' | 'api' | 'realtime' | 'function' | 'integration'
  name: string
  reason: string
  /** If present, the auto-fix action to emit */
  autoFixAction?: string
  autoFixParams?: Record<string, any>
  /** How confident we are this was expected (0–1) */
  confidence: number
}

export interface CriticResult {
  /** Resources that were clearly expected but not found in artifacts */
  gaps: ExpectedResource[]
  /** Whether there are critical gaps that should be auto-fixed or surfaced */
  hasCriticalGaps: boolean
  /** Human-readable summary of what was missed */
  gapSummary: string | null
  /** Suggested follow-up message to the user */
  followUpMessage: string | null
}

export interface ArtifactState {
  tables: string[]
  authEnabled: boolean
  buckets: string[]
  apisCount: number
  functionsCount: number
  integrationsEnabled: string[]
  realtimeEnabled: boolean
}

// ── Domain keyword → expected resource mappings ───────────────────────────────

const STORAGE_SIGNALS = [
  /\b(media|image[s]?|photo[s]?|video[s]?|upload[s]?|attachment[s]?|file[s]?|avatar[s]?|thumbnail[s]?|asset[s]?)\b/i,
  /\b(post.?media|user.?images?|profile.?pic|cover.?photo)\b/i,
]

const AUTH_SIGNALS = [
  /\b(auth|login|sign.?in|sign.?up|register|account|user[s]?)\b/i,
  /\b(password|token|session|jwt|oauth)\b/i,
]

const NOTIFICATIONS_SIGNALS = [
  /\b(notification[s]?|notify|alert[s]?|remind[er]?)\b/i,
  /\b(email.*(when|on|after|if)|send.*email)\b/i,
]

const REALTIME_SIGNALS = [
  /\b(realtime|real.?time|live|chat|websocket|instant|broadcast)\b/i,
  /\b(live.?update|push.?notification|streaming)\b/i,
]

const PAYMENTS_SIGNALS = [
  /\b(payment[s]?|stripe|checkout|billing|subscription|invoice)\b/i,
  /\b(buy|purchase|order|cart|checkout)\b/i,
]

const SOCIAL_SIGNALS = [
  /\b(social|community|forum|post[s]?|comment[s]?|like[s]?|follow|feed)\b/i,
]

const ANALYTICS_SIGNALS = [
  /\b(analytics|dashboard|metrics|stats|report[s]?|tracking)\b/i,
]

// ── Core critic ───────────────────────────────────────────────────────────────

/**
 * Analyzes the original request and current artifact state to find gaps.
 *
 * @param originalRequest  The user's original message (before any resolution)
 * @param artifacts        What was actually built in this session
 */
export function runSelfCritic(
  originalRequest: string,
  artifacts: ArtifactState,
): CriticResult {
  const req = originalRequest.toLowerCase()
  const gaps: ExpectedResource[] = []

  // ── Storage check ─────────────────────────────────────────────────────
  const needsStorage = STORAGE_SIGNALS.some(p => p.test(req))
  if (needsStorage && artifacts.buckets.length === 0) {
    // Infer bucket names from the request
    const bucketName = inferStorageBucketName(req)
    gaps.push({
      type: 'storage',
      name: bucketName,
      reason: 'request mentions media or file uploads but no storage bucket was created',
      autoFixAction: 'CREATE_BUCKET',
      autoFixParams: { bucketName, isPublic: false },
      confidence: 0.85,
    })
  }

  // ── Auth check ────────────────────────────────────────────────────────
  const needsAuth = AUTH_SIGNALS.some(p => p.test(req))
  if (needsAuth && !artifacts.authEnabled) {
    gaps.push({
      type: 'auth',
      name: 'authentication',
      reason: 'request mentions users or login but auth was not enabled',
      autoFixAction: 'ENABLE_AUTH',
      autoFixParams: {},
      confidence: 0.8,
    })
  }

  // ── Notifications check ────────────────────────────────────────────────
  const needsNotifications = NOTIFICATIONS_SIGNALS.some(p => p.test(req))
  const hasNotificationsTable = artifacts.tables.some(t =>
    /notification[s]?|alert[s]?/i.test(t),
  )
  if (needsNotifications && !hasNotificationsTable) {
    gaps.push({
      type: 'table',
      name: 'notifications',
      reason: 'request mentions notifications but no notifications table was created',
      autoFixAction: 'CREATE_TABLE',
      autoFixParams: {
        tableName: 'notifications',
        columns: [
          { name: 'user_id', type: 'UUID' },
          { name: 'type', type: 'TEXT' },
          { name: 'title', type: 'TEXT' },
          { name: 'body', type: 'TEXT' },
          { name: 'read', type: 'BOOLEAN' },
          { name: 'data', type: 'JSONB' },
        ],
      },
      confidence: 0.75,
    })
  }

  // ── Realtime check ─────────────────────────────────────────────────────
  const needsRealtime = REALTIME_SIGNALS.some(p => p.test(req))
  if (needsRealtime && !artifacts.realtimeEnabled) {
    gaps.push({
      type: 'realtime',
      name: 'realtime subscriptions',
      reason: 'request mentions realtime or live features but realtime was not enabled',
      confidence: 0.7,
    })
  }

  // ── Payments check ─────────────────────────────────────────────────────
  const needsPayments = PAYMENTS_SIGNALS.some(p => p.test(req))
  const hasOrdersTable = artifacts.tables.some(t => /order[s]?|payment[s]?|cart/i.test(t))
  const hasStripeIntegration = artifacts.integrationsEnabled.some(i => /stripe/i.test(i))
  if (needsPayments && !hasOrdersTable && !hasStripeIntegration) {
    gaps.push({
      type: 'table',
      name: 'orders + payments',
      reason: 'request mentions payments or checkout but no orders/payments tables were created',
      confidence: 0.75,
    })
  }

  // ── Social app social tables check ────────────────────────────────────
  const isSocialApp = SOCIAL_SIGNALS.some(p => p.test(req))
  if (isSocialApp) {
    const hasPostsTable = artifacts.tables.some(t => /post[s]?/i.test(t))
    const hasCommentsTable = artifacts.tables.some(t => /comment[s]?/i.test(t))
    const hasLikesTable = artifacts.tables.some(t => /like[s]?/i.test(t))

    if (hasPostsTable && !hasCommentsTable) {
      gaps.push({
        type: 'table',
        name: 'comments',
        reason: 'social app with posts typically needs a comments table',
        autoFixAction: 'CREATE_TABLE',
        autoFixParams: { tableName: 'comments' },
        confidence: 0.65,
      })
    }
    if (hasPostsTable && !hasLikesTable && /like[s]?|heart/i.test(req)) {
      gaps.push({
        type: 'table',
        name: 'likes',
        reason: 'request mentions likes but no likes table was created',
        autoFixAction: 'CREATE_TABLE',
        autoFixParams: { tableName: 'likes' },
        confidence: 0.7,
      })
    }
  }

  // ── Filter by confidence threshold ────────────────────────────────────
  const highConfidenceGaps = gaps.filter(g => g.confidence >= 0.7)
  const hasCriticalGaps = highConfidenceGaps.length > 0

  // ── Build gap summary ─────────────────────────────────────────────────
  let gapSummary: string | null = null
  let followUpMessage: string | null = null

  if (highConfidenceGaps.length > 0) {
    const items = highConfidenceGaps.map(g => g.name).slice(0, 3)
    gapSummary = `Missing: ${items.join(', ')}.`

    if (highConfidenceGaps.length === 1) {
      const g = highConfidenceGaps[0]
      followUpMessage = `I also noticed ${g.reason}. Should I add ${g.name}?`
    } else {
      followUpMessage = `A few things were requested but not yet built: ${items.join(', ')}. Should I add them now?`
    }
  }

  return {
    gaps: highConfidenceGaps,
    hasCriticalGaps,
    gapSummary,
    followUpMessage,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferStorageBucketName(req: string): string {
  if (/video[s]?/i.test(req)) return 'videos'
  if (/photo[s]?|image[s]?/i.test(req)) return 'images'
  if (/avatar[s]?|profile.?pic/i.test(req)) return 'avatars'
  if (/post.?media/i.test(req)) return 'post-media'
  if (/product.?image[s]?/i.test(req)) return 'product-images'
  if (/attachment[s]?/i.test(req)) return 'attachments'
  if (/document[s]?/i.test(req)) return 'documents'
  return 'uploads'
}
