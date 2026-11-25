export const dynamic = 'force-dynamic'
export const maxDuration = 900

/**
 * POST /api/import/worker/{action} — calls from an import's sandbox task
 * (lib/import/worker/main.ts): spec, preview, checked, next, progress, op,
 * file, finish, fail. No session: each call proves its one job with that job's
 * token (lib/import/worker-api.ts, which checks everything a task sends).
 *
 * Backenly Cloud only (404 elsewhere).
 */

import { NextRequest } from 'next/server'
import { cloudOnly } from '@/lib/import/http'
import { handleWorkerCall } from '@/lib/import/worker-api'

async function handle(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params
  return handleWorkerCall(action, request)
}

export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  return cloudOnly() ?? handle(request, context)
}
