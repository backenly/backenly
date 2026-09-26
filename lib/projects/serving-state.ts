/**
 * Is this project allowed to serve its runtime API right now?
 *
 * One answer, read by the runtime's serving gate (server/lib/serving-gate.ts)
 * in front of EVERY `/api/v1/:projectId` and `/api/v2/:projectId` route.
 *
 * Two things stop a project serving: founder lockdown (`lockedDownAt`) and an
 * inactivity pause (`pausedAt`, set only by Backenly Cloud through
 * lib/projects/pause-lifecycle.ts). Both are refusals this module must never
 * lose to an error, so both get the fail-closed treatment below.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Founder lockdown (`Project.lockedDownAt`) is described as sealing a project
 * completely, and until this module it did not. It was checked in exactly three
 * places: the Next-owned v1 middleware and the two bootstrap routes. The Express
 * runtime, which is what actually serves `/db/*`, `/v2/*`, end-user auth,
 * functions and realtime in production, never looked at it. A project locked
 * because it was compromised kept answering full CRUD to anyone holding a key.
 *
 * Adding the check to each router would have recreated the drift that caused
 * it: `v1AuthMiddleware`, `getProjectIdFromAuth`, the v2 handler, end-user auth
 * and OAuth each authenticate differently, and the next route would not know to
 * ask. So the question moves in front of all of them, and this is where it is
 * answered.
 *
 * ── Fail CLOSED, deliberately ───────────────────────────────────────────────
 *
 * Most gates on the hot path fail open (the quota kernel, the build lock), and
 * that is right for them: an outage should not block a user. This one guards an
 * EMERGENCY lockdown, and a database error must never be the thing that unseals
 * a sealed project. So, when the lookup fails:
 *
 *   cached locked      -> still locked (or paused), however stale. An error can
 *   or paused             only ever keep a project refused, never release it.
 *   cached serving     -> serving, but only within STALE_SERVING_GRACE_MS of
 *                         when that answer stopped being fresh. One dropped
 *                         query should not take a live app down.
 *   nothing to go on   -> `unavailable`, which the gate answers with 503.
 *
 * Refusing when there is no trustworthy answer costs nothing real: the data
 * plane reads the same database, so a request this lookup could not serve would
 * have failed a few milliseconds later anyway.
 *
 * ── Bounded, on purpose ─────────────────────────────────────────────────────
 *
 * The key is a project id taken straight from the URL, before authentication.
 * An unbounded map would let anyone grow this process's memory by requesting
 * random UUIDs. The cache is an LRU with a hard ceiling, and `not_found` answers
 * are cached too (briefly) so the same garbage id costs one query, not one per
 * request.
 *
 * ── Staleness ───────────────────────────────────────────────────────────────
 *
 * The runtime and the web app are separate processes. Lockdown is written by
 * the web app, so this cache cannot be invalidated across the process boundary;
 * FRESH_MS is the bound on how long a newly locked or paused project can keep
 * serving from a runtime that had just read it, and on how long a resumed one
 * keeps being refused.
 */
import { prisma } from '@/lib/db/prisma'

export type ProjectServingState =
  | { kind: 'serving' }
  | { kind: 'not_found' }
  | { kind: 'locked'; reason: string | null }
  /**
   * Paused for inactivity (Backenly Cloud only; nothing public sets it). Holds
   * the same fail-closed guarantee as a lock: an error never resumes a project.
   */
  | { kind: 'paused'; pausedAt: Date; reason: string | null }
  /** The lookup failed and there was nothing trustworthy to fall back on. */
  | { kind: 'unavailable' }

type KnownState = Exclude<ProjectServingState, { kind: 'unavailable' }>

/** What a loader reports: null when no such project exists. */
export interface ServingRow {
  lockedDownAt: Date | null
  lockedDownReason: string | null
  pausedAt: Date | null
  pauseReason: string | null
}

export interface ServingStateReaderOptions {
  load: (projectId: string) => Promise<ServingRow | null>
  now?: () => number
  maxEntries?: number
  freshMs?: number
  notFoundFreshMs?: number
  staleServingGraceMs?: number
}

export interface ServingStateReader {
  get(projectId: string): Promise<ProjectServingState>
  /** Drop one project's cached answer, for a writer in the same process. */
  invalidate(projectId: string): void
  size(): number
}

export const FRESH_MS = 15_000
export const NOT_FOUND_FRESH_MS = 5_000
export const STALE_SERVING_GRACE_MS = 60_000
export const MAX_ENTRIES = 10_000

interface Entry {
  state: KnownState
  freshUntil: number
}

function toState(row: ServingRow | null): KnownState {
  if (!row) return { kind: 'not_found' }
  // A lock outranks a pause: it is the operator sealing a compromised project,
  // and resuming must not be the thing that appears to lift it.
  if (row.lockedDownAt) return { kind: 'locked', reason: row.lockedDownReason }
  if (row.pausedAt) return { kind: 'paused', pausedAt: row.pausedAt, reason: row.pauseReason }
  return { kind: 'serving' }
}

/**
 * Build a reader around any loader.
 *
 * Exported so the failure policy can be exercised with a loader that throws on
 * demand. The product uses the single instance below, whose loader is Prisma.
 */
export function createServingStateReader(options: ServingStateReaderOptions): ServingStateReader {
  const now = options.now ?? Date.now
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const freshMs = options.freshMs ?? FRESH_MS
  const notFoundFreshMs = options.notFoundFreshMs ?? NOT_FOUND_FRESH_MS
  const staleServingGraceMs = options.staleServingGraceMs ?? STALE_SERVING_GRACE_MS

  // A Map iterates in insertion order, so re-inserting on every hit makes the
  // first key the least recently used one. That is the whole LRU.
  const entries = new Map<string, Entry>()

  function remember(projectId: string, entry: Entry): void {
    entries.delete(projectId)
    entries.set(projectId, entry)
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  async function get(projectId: string): Promise<ProjectServingState> {
    const cached = entries.get(projectId)
    const at = now()

    if (cached && cached.freshUntil > at) {
      remember(projectId, cached)
      return cached.state
    }

    try {
      const state = toState(await options.load(projectId))
      remember(projectId, {
        state,
        freshUntil: at + (state.kind === 'not_found' ? notFoundFreshMs : freshMs),
      })
      return state
    } catch (err: any) {
      console.error(
        `[ServingState] Could not read project ${projectId}; failing closed:`,
        err?.message ?? err,
      )
      if (cached?.state.kind === 'locked' || cached?.state.kind === 'paused') return cached.state
      if (cached?.state.kind === 'serving' && at - cached.freshUntil <= staleServingGraceMs) {
        return cached.state
      }
      return { kind: 'unavailable' }
    }
  }

  return {
    get,
    invalidate: projectId => {
      entries.delete(projectId)
    },
    size: () => entries.size,
  }
}

const reader = createServingStateReader({
  load: projectId =>
    prisma.project.findUnique({
      where: { id: projectId },
      select: { lockedDownAt: true, lockedDownReason: true, pausedAt: true, pauseReason: true },
    }),
})

export function getProjectServingState(projectId: string): Promise<ProjectServingState> {
  return reader.get(projectId)
}

export function invalidateProjectServingState(projectId: string): void {
  reader.invalidate(projectId)
}

// ── The paused answer, one contract for every door ───────────────────────────
//
// The runtime gate, the Next-owned v1 middleware, MCP and the storage download
// route all refuse a paused project, and a client must see the same body from
// each. The message says the API is paused and nothing more: a public file
// served straight from a CDN is not stopped by a pause, so this must not
// suggest the project's files went offline or became private.

export const PAUSED_CODE = 'PROJECT_PAUSED'

export const PAUSED_MESSAGE =
  'This project is paused because it has not been used recently. ' +
  'Its owner can resume it from the dashboard.'

/** Where an owner resumes it, relative to the dashboard origin. */
export function resumePath(projectId: string): string {
  return `/app/projects/${projectId}`
}

export function pausedDetails(
  projectId: string,
  state: { pausedAt: Date; reason: string | null },
): Record<string, string | null> {
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, '')
  // Absolute only when this process knows the dashboard's origin. A guessed
  // host would send a self-hoster's users to somebody else's site.
  const resumeUrl = origin ? `${origin}${resumePath(projectId)}` : null
  return {
    pausedAt: state.pausedAt.toISOString(),
    reason: state.reason,
    resumePath: resumePath(projectId),
    resumeUrl,
    // `hint` and `fixUrl` are the fields the SDK's BackenlyError already turns
    // into a console banner, so a developer sees why every call is failing and
    // where to fix it without opening the network tab.
    hint:
      'This project is paused, so every API call is refused until it is resumed. ' +
      'Its owner can resume it from the Backenly dashboard.',
    fixUrl: resumeUrl,
  }
}
