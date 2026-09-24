export const dynamic = 'force-dynamic'

/**
 * /api/v2/{projectId}/… — the PostgREST-grammar data API, served by the runtime.
 *
 * Next has no v2 handlers of its own. Where Next is the ingress and a separate
 * runtime serves the API (RUNTIME_API_URL: AWS, docker/compose.stack.yml),
 * every request is forwarded to it (lib/runtime/forward-to-runtime.ts). Before
 * this route existed the platform auth middleware answered every v2 request
 * with 401, so the SDK's query builder could not reach a single table in
 * production.
 *
 * With no runtime configured there is nothing to forward to, and it says so.
 */

import { NextRequest, NextResponse } from 'next/server'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { forwardToRuntime, runtimeOrigin } from '@/lib/runtime/forward-to-runtime'

async function handler(request: NextRequest, _props: { params: Promise<{ projectId: string; path?: string[] }> }) {
  const origin = runtimeOrigin()
  if (origin) return forwardToRuntime(request, origin)
  return NextResponse.json(
    {
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'The /api/v2 data API is served by the runtime, which this deployment does not route to from here.',
      },
    },
    { status: 404 },
  )
}

export const GET = recordedV1(handler)
export const POST = recordedV1(handler)
export const PUT = recordedV1(handler)
export const PATCH = recordedV1(handler)
export const DELETE = recordedV1(handler)
export const HEAD = recordedV1(handler)
export const OPTIONS = recordedV1(handler)
