export const dynamic = 'force-dynamic'

/**
 * The Getting Started guide.
 *
 *   GET  /api/onboarding   whether the guide shows, and its derived progress
 *   POST /api/onboarding   { action: 'dismiss' }                   hide it (or finish it)
 *                          { action: 'reopen' }                    show it again
 *                          { action: 'track', event, step? }       report one interaction
 *
 * Platform-authenticated and scoped to the caller: it takes no project or key id
 * from input. Which projects count is ProjectLifecycle's answer, and credentials
 * are the caller's own. Step state is derived server-side from product state
 * (lib/onboarding/guide.ts); nothing a client sends can mark a step done.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { GUIDE_ACTIONS, isStepId, type GuideAction } from '@/lib/onboarding/guide'
import { PreferenceUnavailableError } from '@/lib/onboarding/preference'
import { hideGuide, loadGuideState, showGuide, trackGuideAction, type GuideCaller } from '@/lib/onboarding/state'

const NO_STORE = { 'cache-control': 'no-store' }

function callerOf(user: { userId: string; user: { createdAt: Date } }): GuideCaller {
  return { userId: user.userId, createdAt: user.user.createdAt }
}

export const GET = withAuth(async (_request: NextRequest, { user }) => {
  const state = await loadGuideState(callerOf(user))
  return NextResponse.json(state, { headers: NO_STORE })
})

export const POST = withAuth(async (request: NextRequest, { user }) => {
  let body: { action?: unknown; event?: unknown; step?: unknown } = {}
  try {
    body = (await request.json()) ?? {}
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 })
  }

  const caller = callerOf(user)
  try {
    switch (body.action) {
      case 'dismiss':
        return NextResponse.json(await hideGuide(caller), { headers: NO_STORE })
      case 'reopen':
        return NextResponse.json(await showGuide(caller), { headers: NO_STORE })
      case 'track': {
        if (!(GUIDE_ACTIONS as readonly unknown[]).includes(body.event)) {
          return NextResponse.json({ error: `event must be one of ${GUIDE_ACTIONS.join(', ')}` }, { status: 400 })
        }
        if (body.step !== undefined && body.step !== null && !isStepId(body.step)) {
          return NextResponse.json({ error: 'Unknown step' }, { status: 400 })
        }
        trackGuideAction(caller, body.event as GuideAction, isStepId(body.step) ? body.step : null)
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: 'action must be dismiss, reopen or track' }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof PreferenceUnavailableError) {
      return NextResponse.json({ error: err.message, code: 'PREFERENCE_UNAVAILABLE' }, { status: 503 })
    }
    throw err
  }
})
