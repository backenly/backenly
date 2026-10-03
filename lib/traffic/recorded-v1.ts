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
 */

import { recordRuntimeRequest, INTERNAL_TRAFFIC_HEADER, isInternalTraffic } from './request-recorder'
import { meterResponseBody } from '@/lib/usage/egress'

export function recordedV1<R extends Request, C, T extends Response>(
  handler: (request: R, context: C) => T | Promise<T>,
): (request: R, context: C) => Promise<T> {
  return async (request, context) => {
    const startedAt = Date.now()
    let statusCode = 500
    const internalHeader = request.headers.get(INTERNAL_TRAFFIC_HEADER)
    const paramsPromise = Promise.resolve((context as { params?: unknown } | undefined)?.params)
    try {
      const response = await handler(request, context)
      statusCode = response.status
      // Backenly's own synthetic requests are neither recorded nor metered.
      if (isInternalTraffic(internalHeader)) return response
      const params = await paramsPromise.catch(() => undefined)
      const projectId = (params as { projectId?: unknown } | undefined)?.projectId
      return typeof projectId === 'string' ? meterResponseBody(response, projectId) : response
    } finally {
      // Resolved after the handler, which has already awaited the same promise.
      paramsPromise
        .then(params => {
          const projectId = (params as { projectId?: unknown } | undefined)?.projectId
          recordRuntimeRequest({
            projectId: typeof projectId === 'string' ? projectId : null,
            method: request.method,
            pathname: new URL(request.url).pathname,
            statusCode,
            durationMs: Date.now() - startedAt,
            internalHeader,
          })
        })
        .catch(() => {})
    }
  }
}
