export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { currentEndUser } from '@/lib/services/end-user-auth-flows'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { inAuthEnvironment } from '@/lib/branches/next-auth-environment'

/**
 * GET /v1/{projectId}/auth/me
 *
 * The signed-in end user. Thin wrapper: the flow lives in
 * lib/services/end-user-auth-flows.ts and is shared with the Express runtime,
 * so both answer it the same way. The token is read from Authorization
 * (Bearer) or X-User-Token, the header the SDK sends it in.
 */
async function handleGET(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params
  const authorization = request.headers.get('authorization')
  const token = authorization?.startsWith('Bearer ')
    ? authorization.substring(7)
    : request.headers.get('x-user-token') || null
  return inAuthEnvironment(request, params.projectId, async (env) => {
    const result = await currentEndUser(params.projectId, token, env)
    return NextResponse.json(result.body, { status: result.status })
  })
}

export const GET = recordedV1(handleGET)
