/**
 * PHASE 3 — serve a project's CRUD from PostgREST while keeping Backenly's
 * public contract byte-for-byte.
 *
 * Slotted INTO the existing dynamic route rather than mounted ahead of it, so
 * authentication, rate limiting and usage logging keep running exactly once and
 * exactly as before. Only the execution step changes. A separate mount would
 * have duplicated the auth chain, and two copies of an auth chain drift.
 *
 * Everything this module adds back — exposure checks, the soft-delete
 * predicate, the response envelope — exists because PostgREST does not have it.
 * See lib/postgrest/translate.ts and lib/postgrest/exposure.ts for why each one
 * is load-bearing rather than cosmetic.
 */

import type { Request, Response } from 'express'
import {
  buildUpstreamHeaders,
  internalClaimsFor,
  mintInternalToken,
  profileForProject,
  profileForBranchSchema,
  upstreamUrl,
} from '@/lib/postgrest/gateway'
import {
  toApiError,
  toListEnvelope,
  toRecordEnvelope,
  translateReadQuery,
} from '@/lib/postgrest/translate'
import { checkExposure, operationFor, tableHasSoftDelete } from '@/lib/postgrest/exposure'
import { ensureSchemaRegistered } from '@/lib/postgrest/registration'

export interface PostgrestCallerContext {
  projectId: string
  endUserId?: string
  isServiceRole?: boolean
  /**
   * Branch schema to serve instead of main, resolved from the API key during
   * authentication. Undefined means main.
   *
   * It arrives here already validated by getProjectIdFromAuth and is validated
   * AGAIN by profileForBranchSchema below. That is deliberate duplication: this
   * value becomes the Accept-Profile header, and a header that selects a
   * PostgreSQL schema is the one input in this file that must never be trusted
   * from a caller, however trustworthy the caller looks.
   */
  branchSchema?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Is this PostgREST telling us the schema is not in its exposed list?
 *
 * Matched on the CODE, not the message. PostgREST's wording for PGRST106
 * enumerates every exposed schema — i.e. every other tenant's id — so the
 * message must never be inspected loosely, echoed, or logged at a level that
 * reaches a response body. See `stripUpstreamError` in translate.ts.
 */
function isInvalidSchemaError(parsed: unknown): boolean {
  const b = (parsed ?? {}) as Record<string, unknown>
  return b.code === 'PGRST106'
}

/**
 * Upstream timeout. Without one, a stalled PostgREST holds Express sockets open
 * until the client gives up, and a single slow query turns into exhaustion of
 * the whole runtime's connection capacity.
 */
const UPSTREAM_TIMEOUT_MS = 15_000

/**
 * Handle `[table]` or `[table, id]` against PostgREST.
 *
 * Returns false when the path is not plain CRUD (search, bulk, sub-resources).
 * There is no second engine behind this any more — the caller in dynamic.ts
 * turns a false into an explicit 404 pointing at /api/v2. Returning false means
 * "no data-plane route exists for this shape", NOT "someone else will serve it".
 */
export async function handleViaPostgrest(
  req: Request,
  res: Response,
  path: string[],
  ctx: PostgrestCallerContext,
): Promise<boolean> {
  if (path.length === 0 || path.length > 2) return false

  const [table, maybeId] = path
  // Sub-resources like /search and /bulk are not CRUD and have no PostgREST
  // equivalent in this shape, so they are refused rather than translated.
  if (path.length === 2 && !UUID_RE.test(maybeId) && !/^\d+$/.test(maybeId)) return false

  const recordId = path.length === 2 ? maybeId : undefined
  const operation = operationFor(req.method, recordId !== undefined)
  if (!operation) return false

  const baseUrl = process.env.POSTGREST_URL
  const secret = process.env.POSTGREST_JWT_SECRET
  if (!baseUrl || !secret) return false

  // Authorization gate the legacy executor performed implicitly via
  // ApiDefinition lookup. Runs BEFORE anything is forwarded upstream.
  const exposure = await checkExposure(ctx.projectId, table, operation)
  if (!exposure.allowed) {
    res.status(exposure.status ?? 404).json({ error: exposure.error, code: exposure.code })
    return true
  }

  // Throws rather than falling back to main if the branch does not belong to
  // this project. Silently serving main to a credential the owner scoped to a
  // branch is worse than an error: staging writes would land in production and
  // every request would report success.
  const schema = profileForBranchSchema(ctx.projectId, ctx.branchSchema)

  let upstream: globalThis.Response
  let limit = 0
  let offset = 0
  // Hoisted so the PGRST106 self-heal below can replay the identical request
  // after repairing the registration, rather than rebuilding it and risking a
  // retry that differs from what originally failed.
  let url = ''
  let body: string | undefined
  let headers: Record<string, string> = {}

  try {
    const token = mintInternalToken(
      internalClaimsFor({
        projectId: ctx.projectId,
        endUserId: ctx.endUserId,
        serviceRole: ctx.isServiceRole,
      }),
      secret,
    )

    if (operation === 'list' || operation === 'get') {
      const hasSoftDelete = await tableHasSoftDelete(schema, table)
      const translated = translateReadQuery({
        query: req.query as Record<string, string | string[] | undefined>,
        hasSoftDelete,
        recordId,
      })
      limit = translated.limit
      offset = translated.offset
      url = upstreamUrl(baseUrl, table, translated.search)
    } else if (operation === 'create') {
      url = upstreamUrl(baseUrl, table, '')
      body = JSON.stringify(req.body ?? {})
    } else {
      // update / delete are always id-scoped here. The predicate is built from
      // the validated record id only — never from caller-supplied filters, so a
      // crafted query string cannot widen a single-row update into a table-wide
      // one. RLS still applies on top of this.
      const hasSoftDelete = await tableHasSoftDelete(schema, table)
      const translated = translateReadQuery({
        query: {},
        hasSoftDelete,
        recordId,
      })
      url = upstreamUrl(baseUrl, table, translated.search)
      if (operation === 'update') body = JSON.stringify(req.body ?? {})
    }

    headers = buildUpstreamHeaders(req.headers as Record<string, string>, {
      projectId: ctx.projectId,
      internalToken: token,
      method: req.method,
      branchSchema: ctx.branchSchema,
    })
    headers['content-type'] = 'application/json'
    // `count=exact` is what populates Content-Range, which the pagination
    // envelope needs; `return=representation` makes writes echo the row the way
    // the old executor did.
    headers['prefer'] =
      operation === 'list'
        ? 'count=exact'
        : operation === 'create' || operation === 'update'
          ? 'return=representation'
          : 'return=representation'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    console.error(
      `[postgrest] ${req.method} ${ctx.projectId}/${table} failed:`,
      err instanceof Error ? err.message : err,
    )
    res.status(aborted ? 504 : 502).json({
      error: aborted ? 'The database did not respond in time' : 'Data plane unavailable',
      code: aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
    })
    return true
  }

  let text = await upstream.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }

  // ── PGRST106 self-heal ──────────────────────────────────────────────────────
  //
  // "Invalid schema: workspace_<id>" means PostgREST was never told this
  // project's schema exists. It is not a client error and no amount of retrying
  // by the caller fixes it — the whole data plane is dead for that project until
  // something registers the schema.
  //
  // For most of 2026 nothing did. `backenly_pgrst_register_schema()` was called
  // by the cutover script and by no application code at all, so every project
  // created afterwards was born with a dead `/db/*` plane. It presented as a 406
  // on every table, including tables that do not exist, while `/auth/*` and
  // `/fn/*` kept working — which reads exactly like a bug in the caller's own
  // code, and was reported as one after a user rebuilt their entire data layer
  // on HTTP functions to get around it.
  //
  // Registration is now wired into every schema-creation path and enforced by an
  // event trigger. This repairs it anyway, on the first request, because a fault
  // whose blast radius is "one tenant's entire backend" should not need any of
  // those to have been done right. One attempt only: if registration does not
  // fix it, the cause is elsewhere and a retry loop would just turn a clear
  // failure into a slow one.
  if (!upstream.ok && isInvalidSchemaError(parsed)) {
    console.warn(
      `[postgrest] PGRST106 for ${ctx.projectId} — schema was never registered. Repairing.`,
    )
    const repair = await ensureSchemaRegistered(ctx.projectId)
    if (repair.registered) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
        try {
          upstream = await fetch(url, { method: req.method, headers, body, signal: controller.signal })
        } finally {
          clearTimeout(timer)
        }
        text = await upstream.text()
        parsed = null
        if (text) {
          try { parsed = JSON.parse(text) } catch { parsed = null }
        }
        console.warn(
          `[postgrest] Registered ${repair.schema}; replayed request → ${upstream.status}.`,
        )
      } catch (err) {
        console.error(
          `[postgrest] Replay after registering ${repair.schema} failed:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  if (!upstream.ok) {
    // PostgREST's own message can name roles, policies and constraint bodies.
    // The full text goes to the log; the caller gets the sanitised mapping.
    console.error(`[postgrest] upstream ${upstream.status} for ${table}:`, text.slice(0, 500))
    const mapped = toApiError(upstream.status, parsed)
    res.status(mapped.status).json(mapped.body)
    return true
  }

  const rows = Array.isArray(parsed) ? parsed : parsed == null ? [] : [parsed]

  switch (operation) {
    case 'list':
      res.status(200).json(
        toListEnvelope(rows, upstream.headers.get('content-range'), limit, offset),
      )
      return true

    case 'get':
      if (rows.length === 0) {
        res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' })
        return true
      }
      res.status(200).json(toRecordEnvelope(rows[0], 'fetched'))
      return true

    case 'create':
      res.status(201).json(toRecordEnvelope(rows.length === 1 ? rows[0] : rows, 'created'))
      return true

    case 'update':
      if (rows.length === 0) {
        // PostgREST cannot distinguish "no such row" from "RLS hid it", and
        // neither can this layer. 404 is correct for both and leaks less.
        res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' })
        return true
      }
      res.status(200).json(toRecordEnvelope(rows[0], 'updated'))
      return true

    case 'delete':
      if (rows.length === 0) {
        res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' })
        return true
      }
      res.status(200).json({ message: 'Record deleted successfully', data: rows[0] })
      return true
  }

  return false
}
