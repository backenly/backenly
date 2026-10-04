export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { refreshEndUserToken } from '@/lib/services/end-user-auth-flows'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { inAuthEnvironment } from '@/lib/branches/next-auth-environment'

/**
 * POST /v1/{projectId}/auth/refresh-token
 *
 * Thin wrapper — the actual flow lives in lib/services/end-user-auth-flows.ts
 * and is shared with the Express runtime (which serves /api/v1/* in prod).
 *
 * The client passes the current token in the Authorization header
 * (Bearer <token>) or the body as { token }.
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  let rawToken: string | null = null
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    rawToken = authHeader.substring(7)
  } else {
    try {
      const body = await request.json()
      rawToken = body?.token ?? body?.refreshToken ?? null
    } catch {
      // No parseable body — kernel returns the 401 with guidance
    }
  }

  // A preview branch's key refreshes that branch's session, never production's.
  return inAuthEnvironment(request, params.projectId, async (env) => {
    const result = await refreshEndUserToken(params.projectId, rawToken, env)
    return NextResponse.json(result.body, { status: result.status })
  })
}

export const POST = recordedV1(handlePOST)
