export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { forgotEndUserPassword } from '@/lib/services/end-user-auth-flows'

/**
 * POST /v1/{projectId}/auth/forgot-password
 *
 * Thin wrapper — the actual flow lives in lib/services/end-user-auth-flows.ts
 * and is shared with the Express runtime (which serves /api/v1/* in prod).
 *
 * Body: { email }. Always 200 for unknown emails (no user enumeration).
 */
export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  let email: unknown
  try {
    const body = await request.json()
    email = body?.email
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Request body must be JSON with an "email" field.' } },
      { status: 400 }
    )
  }

  const result = await forgotEndUserPassword(params.projectId, email)
  return NextResponse.json(result.body, { status: result.status })
}
