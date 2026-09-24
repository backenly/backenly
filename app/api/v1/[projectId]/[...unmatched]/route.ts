export const dynamic = 'force-dynamic'

/**
 * Everything under /api/v1/{projectId}/ that Next does not serve itself.
 *
 * Static route segments win over a catch-all in the app router, so every real
 * Next handler under /api/v1/{projectId}/ still takes precedence; this only
 * runs when nothing matched.
 *
 * Where a separate runtime serves the rest (RUNTIME_API_URL: AWS and
 * docker/compose.stack.yml, where Next is the ingress), the request is
 * forwarded to it. This used to answer 404 here, which made `/db/{table}`,
 * `/fn/{name}` and the legacy table routes unreachable in production: the
 * rewrite in next.config.js never runs for a path this route matches. See
 * lib/runtime/forward-to-runtime.ts.
 *
 * With no runtime configured, or for a request the runtime itself forwarded
 * here (server/routes/next-proxy.ts on the single-box layout, marked with the
 * internal-traffic header), it is a JSON 404, so a path neither side serves
 * cannot bounce between them. Both runtimes build that body from
 * lib/api/v1/route-not-found, so they cannot drift apart.
 */

import { NextRequest, NextResponse } from 'next/server'
import { v1NotFoundBody } from '@/lib/api/v1/route-not-found'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { forwardToRuntime, runtimeOrigin } from '@/lib/runtime/forward-to-runtime'
import { isInternalTraffic, INTERNAL_TRAFFIC_HEADER } from '@/lib/traffic/request-recorder'

async function handler(
  request: NextRequest,
  props: { params: Promise<{ projectId: string; unmatched?: string[] }> },
) {
  const params = await props.params
  const origin = runtimeOrigin()
  if (origin && !isInternalTraffic(request.headers.get(INTERNAL_TRAFFIC_HEADER))) {
    return forwardToRuntime(request, origin)
  }
  return NextResponse.json(v1NotFoundBody(params.projectId, params.unmatched ?? []), { status: 404 })
}

export const GET = recordedV1(handler)
export const POST = recordedV1(handler)
export const PUT = recordedV1(handler)
export const PATCH = recordedV1(handler)
export const DELETE = recordedV1(handler)
export const HEAD = recordedV1(handler)
export const OPTIONS = recordedV1(handler)
