/**
 * Platform Control Plane
 * =======================
 * Founder-grade emergency switches that every relevant entry-point in the
 * codebase reads before letting work happen:
 *
 *   - aiFrozen          → AI chat + execute routes refuse, log a SecurityEvent
 *   - signupsDisabled   → register + OAuth signups refuse
 *   - maintenanceMode   → all writes (AI + end-user + new projects) refuse
 *   - readOnly          → end-user + AI writes refuse; reads still flow
 *
 * Plus:
 *   - Blocklist (ip / email / domain) read by signup + login flows
 *   - SecurityEvent recorder used by every gate when it fires
 *
 * Read path is cached in-process for 5 s so toggling is near-instant but the
 * hot paths don't pay a DB round-trip per request.
 */

import { assessEmailTrust, type EmailTrustResult } from '@/lib/auth/email-trust'
import { prisma } from '@/lib/db/prisma'
import { currentEdition } from '@/lib/edition'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlatformControlState {
  aiFrozen: boolean
  signupsDisabled: boolean
  maintenanceMode: boolean
  readOnly: boolean
  note: string | null
  updatedAt: Date
  updatedBy: string | null
}

const DEFAULT_STATE: PlatformControlState = {
  aiFrozen: false,
  signupsDisabled: false,
  maintenanceMode: false,
  readOnly: false,
  note: null,
  updatedAt: new Date(0),
  updatedBy: null,
}

// ─── Cached read ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5_000
let _cache: { state: PlatformControlState; expiresAt: number } | null = null

export async function getPlatformControls(force = false): Promise<PlatformControlState> {
  const now = Date.now()
  if (!force && _cache && _cache.expiresAt > now) return _cache.state

  try {
    const row = await prisma.platformControl.findUnique({ where: { id: 'singleton' } })
    const state: PlatformControlState = row
      ? {
          aiFrozen: row.aiFrozen,
          signupsDisabled: row.signupsDisabled,
          maintenanceMode: row.maintenanceMode,
          readOnly: row.readOnly,
          note: row.note,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        }
      : DEFAULT_STATE
    _cache = { state, expiresAt: now + CACHE_TTL_MS }
    return state
  } catch {
    // Fail OPEN — if the control row table is unreachable we don't want to
    // brick the platform. Treat as default (everything enabled).
    return _cache?.state ?? DEFAULT_STATE
  }
}

export function invalidatePlatformControlsCache() {
  _cache = null
}

// ─── Mutation ─────────────────────────────────────────────────────────────────

export interface ControlPatch {
  aiFrozen?: boolean
  signupsDisabled?: boolean
  maintenanceMode?: boolean
  readOnly?: boolean
  note?: string | null
}

export async function setPlatformControls(
  patch: ControlPatch,
  actor: { userId: string; userEmail: string },
): Promise<PlatformControlState> {
  const existing = await prisma.platformControl.findUnique({ where: { id: 'singleton' } })

  const next = await prisma.platformControl.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      aiFrozen: patch.aiFrozen ?? false,
      signupsDisabled: patch.signupsDisabled ?? false,
      maintenanceMode: patch.maintenanceMode ?? false,
      readOnly: patch.readOnly ?? false,
      note: patch.note ?? null,
      updatedBy: actor.userId,
    },
    update: {
      ...(patch.aiFrozen !== undefined ? { aiFrozen: patch.aiFrozen } : {}),
      ...(patch.signupsDisabled !== undefined ? { signupsDisabled: patch.signupsDisabled } : {}),
      ...(patch.maintenanceMode !== undefined ? { maintenanceMode: patch.maintenanceMode } : {}),
      ...(patch.readOnly !== undefined ? { readOnly: patch.readOnly } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      updatedBy: actor.userId,
    },
  })

  invalidatePlatformControlsCache()

  // Record what changed as both an AuditLog (admin trail) and a SecurityEvent
  // (so it shows up on the Security feed alongside attacks/anomalies).
  const diff: string[] = []
  if (existing?.aiFrozen !== next.aiFrozen) diff.push(`aiFrozen=${next.aiFrozen}`)
  if (existing?.signupsDisabled !== next.signupsDisabled) diff.push(`signupsDisabled=${next.signupsDisabled}`)
  if (existing?.maintenanceMode !== next.maintenanceMode) diff.push(`maintenanceMode=${next.maintenanceMode}`)
  if (existing?.readOnly !== next.readOnly) diff.push(`readOnly=${next.readOnly}`)
  const summary = diff.length ? diff.join(', ') : 'no functional change'

  try {
    await prisma.auditLog.create({
      data: {
        action: 'PLATFORM_CONTROLS_UPDATED',
        type: 'admin',
        userId: actor.userId,
        userEmail: actor.userEmail,
        details: summary,
        metadata: patch as object,
      },
    })
  } catch { /* non-fatal */ }

  if (next.aiFrozen || next.maintenanceMode || next.readOnly) {
    await recordSecurityEvent({
      kind: 'kill_switch',
      severity: 'critical',
      userId: actor.userId,
      userEmail: actor.userEmail,
      summary: `Founder toggled platform controls: ${summary}`,
      detail: { state: next as unknown as Record<string, unknown> },
    }).catch(() => {})
  }

  return {
    aiFrozen: next.aiFrozen,
    signupsDisabled: next.signupsDisabled,
    maintenanceMode: next.maintenanceMode,
    readOnly: next.readOnly,
    note: next.note,
    updatedAt: next.updatedAt,
    updatedBy: next.updatedBy,
  }
}

// ─── Guard helpers used by the entry-points ──────────────────────────────────

// Single Guard shape — callers do `if (!g.ok) return NextResponse.json({ error: g.reason }, { status: g.status })`.
// reason/status are only present when ok is false, but typing them required
// here keeps callers free of `!.` and TS happy without discriminated-union
// narrowing surprises.
export interface Guard {
  ok: boolean
  reason: string
  status: number
}

const ok: Guard = { ok: true, reason: '', status: 200 }

/**
 * Guard for AI execution paths (chat + execute). Blocks when aiFrozen,
 * maintenanceMode, or readOnly is on.
 */
export async function assertAiAllowed(): Promise<Guard> {
  const c = await getPlatformControls()
  if (c.aiFrozen) {
    return { ok: false, reason: 'AI execution is currently frozen by the platform operator.', status: 503 }
  }
  if (c.maintenanceMode) {
    return { ok: false, reason: 'The platform is in maintenance mode. Try again shortly.', status: 503 }
  }
  if (c.readOnly) {
    return { ok: false, reason: 'The platform is in read-only mode right now.', status: 503 }
  }
  return ok
}

/**
 * Guard for any path that creates / mutates data on behalf of a user.
 * Blocks when maintenanceMode or readOnly is on.
 */
export async function assertWritable(): Promise<Guard> {
  const c = await getPlatformControls()
  if (c.maintenanceMode) {
    return { ok: false, reason: 'The platform is in maintenance mode. Try again shortly.', status: 503 }
  }
  if (c.readOnly) {
    return { ok: false, reason: 'The platform is in read-only mode right now.', status: 503 }
  }
  return ok
}

/**
 * Signup guard result. Carries the trust assessment forward so the caller can
 * persist *how* the account arrived — a `challenge` verdict is allowed through
 * but must land as an untrusted account that has to verify its mailbox before
 * it can consume anything.
 */
export interface SignupGuard extends Guard {
  trust?: EmailTrustResult
}

/**
 * Guard for signup paths. Blocks when signupsDisabled or maintenanceMode is
 * on, when the email/domain/MX is blocklisted, and when the email trust
 * assessment returns a `deny` verdict.
 */
/**
 * Advisory lock key for "who gets to be the first account".
 *
 * Arbitrary but fixed. Two int4s because pg_advisory_xact_lock has an
 * (int4, int4) overload, which keeps the key inside the safe integer range —
 * the same approach lib/billing uses for its per-user monthly locks.
 */
const FIRST_ACCOUNT_LOCK: [number, number] = [0x6261636b, 0x656e6c79] // 'back','enly'

const SELF_HOSTED_CLOSED: SignupGuard = {
  ok: false,
  reason:
    'This is a self-hosted Backenly deployment and registration is closed. ' +
    'The operator can open it with BACKENLY_ALLOW_PUBLIC_SIGNUP=true.',
  status: 403,
}

function selfHostedRegistrationClosed(): boolean {
  return currentEdition() === 'single-tenant' && process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP !== 'true'
}

/**
 * Claim the single self-hosted account slot, atomically, and create the user.
 *
 * The check in `assertSignupAllowed` is a fast pre-flight and CANNOT be the
 * enforcement: it runs about fifty lines before the insert, so two concurrent
 * first signups both read zero, both proceed, and a single-operator install
 * quietly ends up with two operators. A count followed by an insert is not a
 * decision, it is a race.
 *
 * So the count is repeated INSIDE the transaction that inserts, behind a
 * transaction-scoped advisory lock. The lock is released when the transaction
 * ends either way, so a failed signup cannot wedge registration shut.
 *
 * Cloud takes no lock: there is no slot to contend for, and serialising every
 * signup in the product behind one lock would be a self-inflicted bottleneck.
 */
export async function createUserClaimingSignupSlot<T>(
  create: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!selfHostedRegistrationClosed()) {
    return create(prisma as any)
  }

  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_LOCK[0]}::int4, ${FIRST_ACCOUNT_LOCK[1]}::int4)`
    const existing = await tx.user.count()
    // Throwing rather than returning a union keeps the happy path's type clean
    // and, more importantly, ABORTS the transaction: a refusal must not leave a
    // half-written signup behind.
    if (existing > 0) throw new SignupSlotTakenError()
    return create(tx)
  })
}

/** The self-hosted account slot was claimed by a concurrent request. */
export class SignupSlotTakenError extends Error {
  readonly guard = SELF_HOSTED_CLOSED
  constructor() {
    super(SELF_HOSTED_CLOSED.reason)
    this.name = 'SignupSlotTakenError'
  }
}

export async function assertSignupAllowed(email: string, ip?: string | null): Promise<SignupGuard> {
  // Self-hosted is CLOSED after the first account.
  //
  // A self-hosted deployment is one team's infrastructure, usually reachable
  // from the internet, and it has no abuse defence worth the name: Turnstile,
  // the email-trust heuristics and the blocklist are all inert until an
  // operator configures them. Leaving public signup open by default would mean
  // anyone who finds the URL gets an account on it.
  //
  // The first account is allowed, because otherwise a fresh install has no way
  // to create its operator and the only escape is editing the database by
  // hand. After that, an operator who genuinely wants open registration sets
  // BACKENLY_ALLOW_PUBLIC_SIGNUP=true, which is a decision someone made rather
  // than a default nobody chose.
  if (selfHostedRegistrationClosed()) {
    const existing = await prisma.user.count()
    if (existing > 0) return SELF_HOSTED_CLOSED
  }

  const c = await getPlatformControls()
  if (c.signupsDisabled) {
    return { ok: false, reason: 'New sign-ups are temporarily disabled.', status: 503 }
  }
  if (c.maintenanceMode) {
    return { ok: false, reason: 'The platform is in maintenance mode. Try again shortly.', status: 503 }
  }

  // Operator blocklist runs before the heuristics: a hand-added entry is an
  // explicit decision and should never be second-guessed by a score.
  const hit = await isBlocked({ email, ip })
  if (hit) {
    await recordSecurityEvent({
      kind: 'blocklist_hit',
      severity: 'warn',
      userEmail: email,
      ip: ip ?? null,
      summary: `Blocked signup attempt — ${hit.kind}=${hit.value}`,
      detail: { match: hit, email, ip },
    }).catch(() => {})
    return { ok: false, reason: 'Sign-up is not allowed for this account.', status: 403 }
  }

  const trust = await assessEmailTrust(email)
  if (trust.verdict === 'deny') {
    await recordSecurityEvent({
      kind: 'signup_denied',
      severity: 'warn',
      userEmail: email,
      ip: ip ?? null,
      summary: `Blocked signup — email trust ${trust.score}/100 (${trust.signals.join(', ')})`,
      detail: { email, ip, score: trust.score, signals: trust.signals },
    }).catch(() => {})
    return {
      ok: false,
      reason: trust.reason ?? 'Sign-up is not allowed for this email address.',
      status: trust.signals.includes('invalid_email') ? 400 : 403,
      trust,
    }
  }

  if (trust.verdict === 'challenge') {
    // Not refused — recorded. These are the accounts worth watching, and the
    // caller marks them untrusted so they stay inert until verified.
    await recordSecurityEvent({
      kind: 'signup_untrusted',
      severity: 'info',
      userEmail: email,
      ip: ip ?? null,
      summary: `Untrusted signup allowed — email trust ${trust.score}/100 (${trust.signals.join(', ')})`,
      detail: { email, ip, score: trust.score, signals: trust.signals },
    }).catch(() => {})
  }

  return { ...ok, trust }
}

// ─── Blocklist ────────────────────────────────────────────────────────────────

interface BlocklistMatch { kind: 'ip' | 'email' | 'domain'; value: string }

// Tiny cache so login/signup don't hammer the DB.
let _blockCache: { rows: { kind: string; value: string }[]; expiresAt: number } | null = null
const BLOCKLIST_TTL_MS = 10_000

async function loadBlocklist(): Promise<{ kind: string; value: string }[]> {
  const now = Date.now()
  if (_blockCache && _blockCache.expiresAt > now) return _blockCache.rows
  try {
    const rows = await prisma.blocklist.findMany({ select: { kind: true, value: true } })
    _blockCache = { rows, expiresAt: now + BLOCKLIST_TTL_MS }
    return rows
  } catch {
    return _blockCache?.rows ?? []
  }
}

export function invalidateBlocklistCache() {
  _blockCache = null
}

export async function isBlocked(
  input: { email?: string | null; ip?: string | null },
): Promise<BlocklistMatch | null> {
  const rows = await loadBlocklist()
  if (rows.length === 0) return null
  const email = input.email?.toLowerCase().trim() ?? ''
  const domain = email.includes('@') ? email.split('@')[1] : ''
  const ip = input.ip?.trim() ?? ''
  for (const r of rows) {
    const v = r.value.toLowerCase()
    if (r.kind === 'email' && email && v === email) return { kind: 'email', value: v }
    if (r.kind === 'domain' && domain && (v === domain || domain.endsWith(`.${v}`))) return { kind: 'domain', value: v }
    if (r.kind === 'ip' && ip && v === ip) return { kind: 'ip', value: v }
  }
  return null
}

// ─── Security event recorder ─────────────────────────────────────────────────

export interface SecurityEventInput {
  kind: string
  severity?: 'info' | 'warn' | 'high' | 'critical'
  userId?: string | null
  userEmail?: string | null
  projectId?: string | null
  ip?: string | null
  summary: string
  detail?: Record<string, unknown>
}

export async function recordSecurityEvent(ev: SecurityEventInput): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        kind: ev.kind,
        severity: ev.severity ?? 'info',
        userId: ev.userId ?? null,
        userEmail: ev.userEmail ?? null,
        projectId: ev.projectId ?? null,
        ip: ev.ip ?? null,
        summary: ev.summary,
        detail: ev.detail ? (ev.detail as object) : undefined,
      },
    })
  } catch (err) {
    // Never let logging break a request — but make it visible in server logs.
    console.error('[SecurityEvent] failed to record:', (err as Error)?.message)
  }
}

// ─── Per-project lockdown ────────────────────────────────────────────────────

export async function setProjectLockdown(
  projectId: string,
  locked: boolean,
  reason: string | null,
  actor: { userId: string; userEmail: string },
): Promise<void> {
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, userId: true },
  })
  if (!proj) throw new Error('Project not found')

  // Lockdown is enforced in lib/api/v1/middleware.ts by checking
  // Project.lockedDownAt — single source of truth, so we don't need to mutate
  // every ApiKey row (and risk losing their original expiresAt). Lifting the
  // lockdown is therefore reversible with no side effects.
  await prisma.project.update({
    where: { id: projectId },
    data: {
      lockedDownAt: locked ? new Date() : null,
      lockedDownReason: locked ? reason : null,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: locked ? 'PROJECT_LOCKED_DOWN' : 'PROJECT_LOCKDOWN_LIFTED',
      type: 'admin',
      userId: actor.userId,
      userEmail: actor.userEmail,
      projectId,
      details: reason ?? (locked ? 'Project locked via admin dashboard' : 'Lockdown lifted via admin dashboard'),
    },
  })

  await recordSecurityEvent({
    kind: 'lockdown',
    severity: locked ? 'high' : 'info',
    userId: actor.userId,
    userEmail: actor.userEmail,
    projectId,
    summary: locked
      ? `Project "${proj.name}" locked down: ${reason ?? 'no reason given'}`
      : `Project "${proj.name}" lockdown lifted`,
    detail: { projectId, ownerUserId: proj.userId, reason },
  })
}

/** Cheap predicate used inside the public runtime middleware. */
export async function isProjectLockedDown(projectId: string): Promise<boolean> {
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { lockedDownAt: true },
    })
    return !!p?.lockedDownAt
  } catch {
    return false
  }
}
