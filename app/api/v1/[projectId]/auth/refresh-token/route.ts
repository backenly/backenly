export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { refreshEndUserToken } from '@/lib/services/end-user-auth-flows'

/**
 * POST /v1/{projectId}/auth/refresh-token
 *
 * Thin wrapper — the actual flow lives in lib/services/end-user-auth-flows.ts
 * and is shared with the Express runtime (which serves /api/v1/* in prod).
 *
 * The client passes the current token in the Authorization header
 * (Bearer <token>) or the body as { token }.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
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

  const result = await refreshEndUserToken(params.projectId, rawToken)
  return NextResponse.json(result.body, { status: result.status })
}
