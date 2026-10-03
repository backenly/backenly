/**
 * Operator kill switches, and the guards that read them.
 *
 *   - aiFrozen          → AI chat + execute routes refuse
 *   - signupsDisabled   → register + OAuth signups refuse
 *   - maintenanceMode   → all writes (AI + end-user + new projects) refuse
 *   - readOnly          → end-user + AI writes refuse; reads still flow
 *
 * These are PUBLIC because they are controls over a deployment, exercised by
 * whoever operates it. A self-hoster freezing AI or putting their own box into
 * read-only is ordinary product functionality, and making these guards no-ops
 * in OSS would take a real capability away from the public product rather than
 * withhold a commercial one.
 *
 * The founder console that WRITES them is a different matter and stays with the
 * back office. Reading and enforcing is here; Backenly's admin mutation surface
 * is not. A self-host UI for toggling these can be added deliberately later,
 * rather than arriving by accident because the founder endpoint was public.
 *
 * Read path is cached in-process for 5s so toggling is near-instant but the hot
 * paths do not pay a DB round-trip per request.
 */
import { prisma } from '@/lib/db/prisma'

export interface PlatformControlState {
  aiFrozen: boolean
  signupsDisabled: boolean
  maintenanceMode: boolean
  readOnly: boolean
  note: string | null
  updatedAt: Date
  updatedBy: string | null
}

export const DEFAULT_STATE: PlatformControlState = {
  aiFrozen: false,
  signupsDisabled: false,
  maintenanceMode: false,
  readOnly: false,
  note: null,
  updatedAt: new Date(0),
  updatedBy: null,
}

/** The shape the founder console patches. Kept public so the private writer can type against it. */
export interface ControlPatch {
  aiFrozen?: boolean
  signupsDisabled?: boolean
  maintenanceMode?: boolean
  readOnly?: boolean
  note?: string | null
}

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

// Single Guard shape — callers do `if (!g.ok) return NextResponse.json({ error: g.reason }, { status: g.status })`.
// reason/status are only present when ok is false, but typing them required
// here keeps callers free of `!.` and TS happy without discriminated-union
// narrowing surprises.
export interface Guard {
  ok: boolean
  reason: string
  status: number
}

export const ok: Guard = { ok: true, reason: '', status: 200 }

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
