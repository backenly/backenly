export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { resetEndUserPassword } from '@/lib/services/end-user-auth-flows'

/**
 * POST /v1/{projectId}/auth/reset-password
 *
 * Thin wrapper — the actual flow lives in lib/services/end-user-auth-flows.ts
 * and is shared with the Express runtime (which serves /api/v1/* in prod).
 *
 * Body: { token, password }. Returns a fresh JWT on success so the user is
 * immediately signed in after resetting.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  let token: unknown
  let password: unknown
  try {
    const body = await request.json()
    token = body?.token
    password = body?.password
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Request body must be JSON with "token" and "password" fields.' } },
      { status: 400 }
    )
  }

  const result = await resetEndUserPassword(params.projectId, token, password)
  return NextResponse.json(result.body, { status: result.status })
}
