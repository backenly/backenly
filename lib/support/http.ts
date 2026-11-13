/**
 * One place the support routes turn service refusals into HTTP.
 *
 * CloudOnlyFeatureError maps to 404, not 403: on a self-hosted deployment the
 * support surface does not exist, and 403 would imply it is present and
 * withheld (the same rule the branches routes follow).
 */
import { NextResponse } from 'next/server'
import { CloudOnlyFeatureError } from '@/lib/edition/cloud-only'
import { consume, type RateLimitResult } from '@/lib/security/auth-rate-limit'
import { rateLimitHeaders } from '@/lib/security/rate-limit-decision'
import { SupportError } from './service'

export function supportErrorResponse(err: unknown): NextResponse {
  if (err instanceof CloudOnlyFeatureError) {
    return NextResponse.json({ error: 'Not found', code: 'CLOUD_ONLY_FEATURE' }, { status: 404 })
  }
  if (err instanceof SupportError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
  }
  console.error('[Support] route error:', err)
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
}

export type SupportAction = 'create' | 'reply' | 'ai-retry'

/** The limiter key of one person's budget for one support action. */
export function supportBudgetKey(action: SupportAction, userId: string): string {
  return `support:${action}:${userId}`
}

/**
 * One unit of a person's hourly budget for a support action
 * (lib/support/constants.ts), counted by the limiter the auth surfaces use.
 * Returns the refusal to send, or null when the action may go ahead.
 *
 * A limiter that cannot count answers 503, not "too many": the person has done
 * nothing wrong, and the action is still refused until it can count again.
 */
export async function spendSupportBudget(
  action: SupportAction,
  userId: string,
  budget: { limit: number; windowMs: number },
  tooMany: string,
): Promise<NextResponse | null> {
  const result: RateLimitResult = await consume(supportBudgetKey(action, userId), budget.limit, budget.windowMs)
  if (result.allowed) return null
  if (result.outcome === 'store_unavailable') {
    return NextResponse.json(
      { error: 'Support is unavailable for a moment. Please try again shortly.', code: 'RATE_LIMITER_UNAVAILABLE' },
      { status: 503, headers: { ...rateLimitHeaders(result), 'Cache-Control': 'no-store' } },
    )
  }
  return NextResponse.json({ error: tooMany, code: 'RATE_LIMITED' }, { status: 429, headers: rateLimitHeaders(result) })
}
