/**
 * API Route: Backend Replacement (Phase 5)
 * 
 * Server-side only - handles backend takeover after connection approval
 */

import { NextRequest, NextResponse } from 'next/server'
import { replaceBackend } from '@/lib/services/backend-replacement'
import { autoConnectFrontend } from '@/lib/services/auto-connection'
import { sanitizeError } from '@/lib/errors/sanitize'
import { requireAuth } from '@/lib/auth/middleware'

export async function POST(request: NextRequest) {
  try {
    // 🔒 Previously this route accepted `userId` from the request body with no
    // auth check — any authed caller could pass another user's id and take
    // over their backend. Bind the operation to the authenticated user.
    const auth = await requireAuth(request)

    const body = await request.json()
    const { blueprint, provider, appUrl } = body

    if (!blueprint || !provider || !appUrl) {
      return NextResponse.json(
        { error: "Something didn't work. Please try again." },
        { status: 400 }
      )
    }

    // Phase 5: Replace backend — always uses the authenticated user's id.
    const replacementResult = await replaceBackend(
      auth.userId,
      blueprint,
      provider,
      appUrl
    )

    if (!replacementResult.success) {
      return NextResponse.json(
        { error: replacementResult.message },
        { status: 500 }
      )
    }

    // Phase 6: Auto-connect frontend
    await autoConnectFrontend({
      projectId: replacementResult.projectId,
      delegationToken: replacementResult.delegationToken,
      provider: provider as any,
      appUrl,
    })

    return NextResponse.json({
      success: true,
      projectId: replacementResult.projectId,
      message: replacementResult.message,
    })
  } catch (error) {
    console.error('[Replace Backend API] Error:', error)
    const humanError = sanitizeError(error)

    return NextResponse.json(
      { error: humanError.message },
      { status: 500 }
    )
  }
}
