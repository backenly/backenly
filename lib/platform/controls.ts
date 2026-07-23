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

import { checkSignupEmailEligibility } from '@/lib/auth/email-eligibility'
import { prisma } from '@/lib/db/prisma'

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
 * Guard for signup paths. Blocks when signupsDisabled or maintenanceMode is
 * on, and when the email/domain is blocklisted.
 */
export async function assertSignupAllowed(email: string, ip?: string | null): Promise<Guard> {
  const c = await getPlatformControls()
  if (c.signupsDisabled) {
    return { ok: false, reason: 'New sign-ups are temporarily disabled.', status: 503 }
  }
  if (c.maintenanceMode) {
    return { ok: false, reason: 'The platform is in maintenance mode. Try again shortly.', status: 503 }
  }

  const emailEligibility = checkSignupEmailEligibility(email)
  if (!emailEligibility.ok) {
    await recordSecurityEvent({
      kind: 'blocklist_hit',
      severity: 'warn',
      userEmail: email,
      ip: ip ?? null,
      summary: `Blocked signup attempt - email trust gate: ${emailEligibility.code ?? 'UNKNOWN'}`,
      detail: { email, ip, reason: emailEligibility.code },
    }).catch(() => {})
    return {
      ok: false,
      reason: emailEligibility.reason ?? 'Sign-up is not allowed for this email address.',
      status: emailEligibility.code === 'INVALID_EMAIL' ? 400 : 403,
    }
  }

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
  return ok
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
