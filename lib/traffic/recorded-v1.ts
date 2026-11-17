/**
 * Wrap a Next.js /api/v1/{projectId} route handler so the request it serves is
 * recorded (lib/traffic/request-recorder.ts) and the bytes it sends are metered
 * (lib/usage/egress.ts).
 *
 * Every route under app/api/v1/[projectId] exports its methods through this,
 * and tests/core/runtime-traffic-is-recorded.test.ts fails the build when one
 * does not: a route that is not wrapped is traffic every autonomy signal is
 * blind to, which is how the log came to be empty in the first place. The same
 * wrapper is what makes every one of those routes metered for egress, the
 * runtime-forwarding catch-all and the realtime stream included.
 *
 * The wrapper keeps the handler's own signature, so Next's route-export type
 * check sees exactly what it saw before.
 *
 * Being the one wrapper every route passes through also makes it the place a
 * key bound to a preview branch is refused off the data plane: apart from
 * end-user sign-up, sign-in, refresh and logout, none of these routes is
 * branch-aware, so serving one would read or write production. The refusal is
 * recorded like any other response. lib/branches/key-scope.ts.
 *
 * It is also where a key used in the wrong place is refused, before the route
 * authenticates and spends the key's rate limit: an MCP key on the runtime API
 * at all, or a service-role key from a browser. lib/security/key-placement.ts.
 *
 * And, before either, where a request for another region's project is refused:
 * each region's projects are served only by that region's service
 * (lib/data-plane/serving.ts, 421 WRONG_REGION with the project's address).
 */

import { NextResponse } from 'next/server'
import { recordRuntimeRequest, INTERNAL_TRAFFIC_HEADER, isInternalTraffic } from './request-recorder'
import { meterResponseBody } from '@/lib/usage/egress'
import { branchIdForRequest, refuseBranchKeyOffDataPlane } from '@/lib/branches/key-scope'
import { refuseMisplacedKey } from '@/lib/security/key-placement'
import { misdirectedResponse } from '@/lib/data-plane/serving'
import { resolvePublicBaseUrl } from '@/lib/services/public-url'
import { servingRefusal } from '@/lib/projects/serving-response'
import { v1ErrorBody } from '@/lib/api/v1/error-shape'
import { postgrestErrorBody } from '@/lib/api/v2/error-shape'
import { v1DbDeprecationHeaders } from '@/lib/api/v1/deprecation'

/** A project id, as the runtime gate requires before it looks one up. */
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const writtenByFunctions = new WeakSet<Response>()

/**
 * A reply whose status a project's function chose, such as a 401 its handler
 * answered: it is the function's, not one of Backenly's errors, so v1's error
 * shaping leaves it as it is, as the runtime's markAsWritten does at /fn
 * (server/lib/v1-error-shape.ts). Given Backenly's `code` for a 401, it would
 * read as Backenly refusing the caller's key.
 */
export function markAsWritten<T extends Response>(response: T): T {
  writtenByFunctions.add(response)
  return response
}

type ErrorShape = (status: number, body: unknown) => unknown

/**
 * A /db response, from a route here or forwarded from the runtime, says /db is
 * deprecated and names its successor on /api/v2 (lib/api/v1/deprecation.ts).
 * The runtime has already set both on what it answered; those are left as
 * they are, so neither header is ever sent twice.
 */
function withDeprecation<T extends Response>(response: T, pathname: string): T {
  const headers = v1DbDeprecationHeaders(pathname)
  if (!headers || response.headers.has('Deprecation')) return response
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
    return response
  } catch {
    // Headers a fetch response holds cannot be changed: answer a copy.
    const copy = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers })
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value)
    return copy as unknown as T
  }
}

/**
 * The error shape of the door a request came through. /api/v2 answers in
 * PostgREST's shape (lib/api/v2/error-shape.ts), as the runtime's own v2
 * errors do; every other door in v1's, with a top-level `code` and `message`.
 * The v2 route is wrapped here too, so its refusals and forwarding errors used
 * to leave in v1's shape (production QA re-test, 2026-11-16, #16).
 */
function errorShapeFor(pathname: string): ErrorShape {
  return pathname.startsWith('/api/v2/') ? postgrestErrorBody : v1ErrorBody
}

/**
 * A JSON error in its door's shape: v1's top-level `code` and `message`
 * (lib/api/v1/error-shape.ts) by default. A success, a body that is not JSON
 * (the realtime stream), an error already in shape and a function's own reply
 * (markAsWritten) are returned as they are.
 */
async function shapedError<T extends Response>(response: T, shape: ErrorShape = v1ErrorBody): Promise<T> {
  if (response.status < 400 || writtenByFunctions.has(response)) return response
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return response
  let body: unknown
  try {
    // A copy is read, so the original can still be returned as it is. A
    // Response without clone() (jest's stand-in) reads its body without
    // consuming it.
    body = typeof response.clone === 'function' ? await response.clone().json() : await response.json()
  } catch {
    return response
  }
  const shaped = shape(response.status, body)
  if (shaped === body) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new NextResponse(JSON.stringify(shaped), { status: response.status, statusText: response.statusText, headers }) as unknown as T
}

export function recordedV1<R extends Request, C, T extends Response>(
  handler: (request: R, context: C) => T | Promise<T>,
): (request: R, context: C) => Promise<T> {
  return async (request, context) => {
    const startedAt = Date.now()
    let statusCode = 500
    const internalHeader = request.headers.get(INTERNAL_TRAFFIC_HEADER)
    const paramsPromise = Promise.resolve((context as { params?: unknown } | undefined)?.params)
    // Next always hands an absolute URL; the base only keeps a relative one (as
    // some callers construct) from throwing before the route runs.
    const url = new URL(request.url, 'http://localhost')
    const shape = errorShapeFor(url.pathname)
    try {
      // First: a project of another region is not served here at all, so no
      // key of it is looked up, checked or rate-limited in the wrong region.
      const requestedProject = ((await paramsPromise.catch(() => undefined)) as { projectId?: unknown } | undefined)?.projectId
      if (typeof requestedProject === 'string') {
        const misdirected = await misdirectedResponse(requestedProject, resolvePublicBaseUrl(request))
        if (misdirected) {
          statusCode = misdirected.status
          return withDeprecation(await shapedError(misdirected as unknown as T, shape), url.pathname)
        }
        // Then a project that is locked, paused or unreadable is not served
        // either, by any route here: the same gate, codes and words as the
        // runtime's (server/lib/serving-gate.ts), so no route Next owns
        // outright (end-user auth, realtime, storage, functions, healthz) can
        // serve a project the runtime would refuse.
        if (PROJECT_ID_RE.test(requestedProject)) {
          const refused = await servingRefusal(requestedProject)
          if (refused) {
            statusCode = refused.status
            return withDeprecation(await shapedError(refused as unknown as T, shape), url.pathname)
          }
        }
      }
      const refusal =
        (await refuseMisplacedKey(url.pathname, request.headers, url, request.method)) ??
        (await refuseBranchKeyOffDataPlane(url.pathname, request.headers, url))
      if (refusal) {
        statusCode = refusal.status
        return withDeprecation(NextResponse.json(shape(refusal.status, refusal.body), { status: refusal.status }) as unknown as T, url.pathname)
      }
      const response = withDeprecation(await shapedError(await handler(request, context), shape), url.pathname)
      statusCode = response.status
      // Backenly's own synthetic requests are neither recorded nor metered.
      if (isInternalTraffic(internalHeader)) return response
      const params = await paramsPromise.catch(() => undefined)
      const projectId = (params as { projectId?: unknown } | undefined)?.projectId
      return typeof projectId === 'string' ? meterResponseBody(response, projectId) : response
    } finally {
      // Resolved after the handler, which has already awaited the same promise.
      // The key's branch keeps preview traffic out of production's health
      // signals; an internal request is never recorded, so it skips the lookup.
      const durationMs = Date.now() - startedAt
      const branch = isInternalTraffic(internalHeader)
        ? Promise.resolve(null)
        : branchIdForRequest(request.headers, url)
      Promise.all([paramsPromise, branch])
        .then(([params, branchId]) => {
          const projectId = (params as { projectId?: unknown } | undefined)?.projectId
          recordRuntimeRequest({
            projectId: typeof projectId === 'string' ? projectId : null,
            method: request.method,
            pathname: url.pathname,
            statusCode,
            durationMs,
            internalHeader,
            branchId,
            // Read to keep the console's own requests and keyless refusals out (isProjectTraffic).
            headers: request.headers,
            search: url.search,
          })
        })
        .catch(() => {})
    }
  }
}

/**
 * Give a route outside /api/v1 v1's error shape: every JSON error it answers
 * carries a top-level `code` and `message`, beside what it already says. For
 * the app-facing routes that are not under /api/v1, such as a stored file's
 * public address (app/api/storage/files/[fileId]/download).
 */
export function withV1ErrorShape<R extends Request, C, T extends Response>(
  handler: (request: R, context: C) => T | Promise<T>,
): (request: R, context: C) => Promise<T> {
  return async (request, context) => shapedError(await handler(request, context))
}
