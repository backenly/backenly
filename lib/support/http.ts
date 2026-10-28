/**
 * One place the support routes turn service refusals into HTTP.
 *
 * CloudOnlyFeatureError maps to 404, not 403: on a self-hosted deployment the
 * support surface does not exist, and 403 would imply it is present and
 * withheld (the same rule the branches routes follow).
 */
import { NextResponse } from 'next/server'
import { CloudOnlyFeatureError } from '@/lib/edition/cloud-only'
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
