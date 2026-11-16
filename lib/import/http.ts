/**
 * What every /api/import route answers the same way: Cloud only (404
 * elsewhere, like the contact and support routes), the budgets, and errors as
 * `{ error, field? }`, never with a credential in them.
 */

import { NextResponse } from 'next/server'
import { isCloudEdition } from '@/lib/edition/cloud-only'
import { consume } from '@/lib/security/auth-rate-limit'
import { rateLimitHeaders } from '@/lib/security/rate-limit-decision'
import { ImportInputError } from './driver'
import { ImportRefusedError } from './jobs'
import { redactedMessage } from './redact'

export const NO_STORE = { 'Cache-Control': 'no-store' }

/** 404 off Cloud: on a self-hosted deployment the capability does not exist. */
export function cloudOnly(): NextResponse | null {
  if (isCloudEdition()) return null
  return NextResponse.json({ error: 'Not found', code: 'CLOUD_ONLY_FEATURE' }, { status: 404 })
}

export const IMPORT_BUDGETS = {
  /** Reading a source to preview it: per person. */
  inspect: { limit: 10, windowMs: 10 * 60_000 },
  /** Starting an import creates a project: per organization. */
  start: { limit: 3, windowMs: 60 * 60_000 },
}

/**
 * Spend one unit of a budget. Over it: an ImportRefusedError, 429 (or 503
 * when the limiter itself is down), with the Retry-After headers.
 */
export async function spendBudget(key: string, budget: { limit: number; windowMs: number }, what: string): Promise<void> {
  const result = await consume(key, budget.limit, budget.windowMs)
  if (result.allowed) return
  if (result.outcome === 'store_unavailable') {
    throw new ImportRefusedError(503, 'Imports are unavailable for a moment. Try again shortly.', 'RATE_LIMITER_UNAVAILABLE', {}, { ...rateLimitHeaders(result), ...NO_STORE })
  }
  throw new ImportRefusedError(429, `Too many ${what}. Try again later.`, 'RATE_LIMITED', {}, rateLimitHeaders(result))
}

export function badRequest(error: string, field?: string): NextResponse {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status: 400, headers: NO_STORE })
}

/** Any error a route caught, as the console reads it. */
export function errorResponse(err: unknown, secrets: readonly string[] = []): NextResponse {
  if (err instanceof ImportInputError) {
    return NextResponse.json(
      { error: redactedMessage(err, secrets), ...(err.field ? { field: err.field } : {}) },
      { status: 422, headers: NO_STORE },
    )
  }
  if (err instanceof ImportRefusedError) {
    return NextResponse.json(
      { error: err.message, ...(err.code ? { code: err.code } : {}), ...err.extra },
      { status: err.status, headers: { ...NO_STORE, ...err.headers } },
    )
  }
  console.error('[Import] unexpected error:', redactedMessage(err, secrets, 500))
  return NextResponse.json({ error: 'Something went wrong on our side. Try again in a minute.' }, { status: 500, headers: NO_STORE })
}

/** Read a JSON body, or null. */
export async function jsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json()
  } catch {
    return null
  }
}
