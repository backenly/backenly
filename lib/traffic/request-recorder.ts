/**
 * Record the requests a project's runtime API actually serves.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `ApiRequestLog` is what every traffic signal in autonomy reads: the change
 * freeze (lib/autonomy/telemetry.ts), the auth-spike detector, the 5xx harm
 * signal behind restructuring, the activity gate, the maintenance observation
 * window and the Monitoring page. Its only writer for real end-user traffic was
 * lib/services/serverlessApiExecutor.ts, which went away with the move to
 * PostgREST, and nothing replaced it. So since then every one of those signals
 * has been reading an empty table: the freeze could never engage and
 * Monitoring showed nothing, however much traffic a backend served.
 *
 * ── How ─────────────────────────────────────────────────────────────────────
 *
 * Each serving process calls `recordRuntimeRequest` once per finished request:
 * the Express runtime from one middleware (server/app.ts), the Next app from
 * `recordedV1` around every /api/v1/{projectId} route. Rows are buffered and
 * written in batches, so a request never waits on the log and a slow database
 * costs a dropped row, never a slow or failed request.
 *
 * Paths are stored relative to the project (`/db/todos`, `/auth/signin`),
 * which is the shape lib/services/metrics.ts and detectAuthSpike read. Rows
 * whose path starts with `/api/` belong to the platform's own AI rate limiter
 * and are excluded by every traffic reader.
 *
 * ── What is never recorded ──────────────────────────────────────────────────
 *
 * Backenly's own synthetic requests (the contract sweep, the behavioral
 * verifier) and a request one process forwards to the other, which the second
 * process would otherwise count again. Both carry `INTERNAL_TRAFFIC_HEADER`
 * with a value derived from the platform secret, so a client cannot use the
 * header to keep its own requests out of the log.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db/prisma'

export const INTERNAL_TRAFFIC_HEADER = 'x-backenly-internal'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FLUSH_MS = 2_000
const FLUSH_AT = 200
/** Beyond this the buffer drops new rows: the log is evidence, never back-pressure. */
const BUFFER_CEILING = 5_000
const OWNER_TTL_MS = 10 * 60 * 1000

/** The header value that marks a request as Backenly's own. Null without a secret. */
export function internalTrafficToken(): string | null {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.trim().length === 0) return null
  return createHmac('sha256', secret).update('backenly-internal-traffic').digest('hex')
}

/** Headers to add to a request Backenly makes to its own runtime API. */
export function internalTrafficHeaders(): Record<string, string> {
  const token = internalTrafficToken()
  return token ? { [INTERNAL_TRAFFIC_HEADER]: token } : {}
}

export function isInternalTraffic(headerValue: string | null | undefined): boolean {
  const expected = internalTrafficToken()
  if (!expected || typeof headerValue !== 'string' || headerValue.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(headerValue), Buffer.from(expected))
}

/**
 * `/api/v1/{projectId}/db/todos?limit=1` → `/db/todos`. Never starts with
 * `/api/`, which is how the traffic readers tell end-user rows from the
 * platform's own.
 */
export function projectRelativePath(projectId: string, pathname: string): string {
  const clean = pathname.split('?')[0]
  const m = clean.match(/^\/api\/v[12]\/([^/]+)(\/.*)?$/)
  const rest = m && m[1] === projectId ? m[2] ?? '/' : clean
  const path = rest.startsWith('/api/') ? rest.replace(/^\/api/, '') : rest
  return path.slice(0, 500) || '/'
}

interface Pending {
  projectId: string
  method: string
  path: string
  statusCode: number
  duration: number
  timestamp: Date
}

const buffer: Pending[] = []
let timer: ReturnType<typeof setTimeout> | null = null
const owners = new Map<string, { userId: string | null; at: number }>()

export interface ServedRequest {
  projectId: string | null | undefined
  method: string
  /** Full request path; the project prefix and query string are removed here. */
  pathname: string
  statusCode: number
  durationMs: number
  /** Value of INTERNAL_TRAFFIC_HEADER, if the request carried one. */
  internalHeader?: string | null
}

/** Queue one served request. Never throws, never awaits the database. */
export function recordRuntimeRequest(req: ServedRequest): void {
  try {
    if (!req.projectId || !UUID_RE.test(req.projectId)) return
    const method = req.method.toUpperCase()
    if (method === 'OPTIONS' || method === 'HEAD') return
    if (isInternalTraffic(req.internalHeader)) return
    if (buffer.length >= BUFFER_CEILING) return

    buffer.push({
      projectId: req.projectId,
      method,
      path: projectRelativePath(req.projectId, req.pathname),
      statusCode: Math.trunc(req.statusCode) || 0,
      duration: Math.max(0, Math.round(req.durationMs)),
      timestamp: new Date(),
    })

    if (buffer.length >= FLUSH_AT) void flushRecordedRequests()
    else if (!timer) {
      timer = setTimeout(() => void flushRecordedRequests(), FLUSH_MS)
      timer.unref?.()
    }
  } catch {
    /* recording must never affect the request it describes */
  }
}

async function ownersOf(projectIds: string[]): Promise<Map<string, string | null>> {
  const now = Date.now()
  const out = new Map<string, string | null>()
  const missing: string[] = []
  for (const id of projectIds) {
    const hit = owners.get(id)
    if (hit && now - hit.at < OWNER_TTL_MS) out.set(id, hit.userId)
    else missing.push(id)
  }
  if (missing.length > 0) {
    const rows = await prisma.project.findMany({
      where: { id: { in: missing } },
      select: { id: true, userId: true },
    })
    const found = new Map(rows.map(r => [r.id, r.userId]))
    for (const id of missing) {
      const userId = found.get(id) ?? null
      owners.set(id, { userId, at: now })
      out.set(id, userId)
    }
  }
  return out
}

/**
 * Write everything buffered. Rows for a project that does not exist (a typo'd
 * id, a deleted project) are dropped: `userId` is the owner and is required.
 * Exported for tests and for a clean shutdown.
 */
export async function flushRecordedRequests(): Promise<number> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (buffer.length === 0) return 0
  const batch = buffer.splice(0, buffer.length)
  try {
    const byProject = await ownersOf([...new Set(batch.map(r => r.projectId))])
    const data = batch.flatMap(r => {
      const userId = byProject.get(r.projectId)
      return userId ? [{ ...r, userId }] : []
    })
    if (data.length === 0) return 0
    const written = await prisma.apiRequestLog.createMany({ data })
    return written.count
  } catch (err: any) {
    console.warn(`[RequestRecorder] dropped ${batch.length} request rows: ${err?.message ?? err}`)
    return 0
  }
}
