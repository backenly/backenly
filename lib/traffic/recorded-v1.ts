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
 */

import { NextResponse } from 'next/server'
import { recordRuntimeRequest, INTERNAL_TRAFFIC_HEADER, isInternalTraffic } from './request-recorder'
import { meterResponseBody } from '@/lib/usage/egress'
import { branchIdForRequest, refuseBranchKeyOffDataPlane } from '@/lib/branches/key-scope'

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
    try {
      const refusal = await refuseBranchKeyOffDataPlane(url.pathname, request.headers, url)
      if (refusal) {
        statusCode = refusal.status
        return NextResponse.json(refusal.body, { status: refusal.status }) as unknown as T
      }
      const response = await handler(request, context)
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
          })
        })
        .catch(() => {})
    }
  }
}
