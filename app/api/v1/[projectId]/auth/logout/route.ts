export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { logoutEndUser } from '@/lib/services/end-user-auth-flows'
import { recordedV1 } from '@/lib/traffic/recorded-v1'

/**
 * POST /v1/{projectId}/auth/logout
 *
 * Thin wrapper — the actual flow lives in lib/services/end-user-auth-flows.ts
 * and is shared with the Express runtime (which serves /api/v1/* in prod).
 *
 * Blacklists the token's jti server-side so revoked tokens are rejected
 * before their natural expiry. Idempotent — always 200.
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
      rawToken = body?.token ?? null
    } catch {
      // No body — still succeed (idempotent logout)
    }
  }

  const result = await logoutEndUser(params.projectId, rawToken)
  return NextResponse.json(result.body, { status: result.status })
}

export const POST = recordedV1(handlePOST)
